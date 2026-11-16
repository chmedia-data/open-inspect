import type { SourceControlProviderName } from "../../source-control";
import { createLogger } from "../../logger";
import type { DockerTransport } from "../docker-transport";
import {
  PrebuiltImageUnavailableError,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type StopConfig,
  type StopResult,
  createVncAccess,
} from "../provider";
import {
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  deriveVncPassword,
  scmCloneIdentity,
} from "../sandbox-env";
import { resolveSandboxPortPlan, type SandboxPortPlan } from "./port-resolution";
import {
  DOCKER_LABELS,
  dockerPortalLabels,
  dockerPortalUrl,
  isDockerSandbox,
  newDockerPortalToken,
  readDockerPortalLabels,
  type DockerPortalConfig,
} from "../docker-portals";
import type { DockerAdmission } from "../docker-admission";
import type { DockerSandboxLimits } from "../docker-limits";

const log = createLogger("docker-provider");
// Fits inside the lifecycle manager's bounded provider-stop budget.
const DOCKER_STOP_TIMEOUT_SECONDS = 5;

/**
 * Every other capability is dropped, notably NET_RAW (packet and ARP forgery
 * on the shared bridge) and NET_ADMIN. Each one kept was shown necessary in
 * the sandbox image (docs/DOCKER_SANDBOX_PROVIDER.md): apt runs its fetchers
 * as `_apt` (SETUID, SETGID) and writes root-only state (DAC_OVERRIDE); npm
 * and package scripts chown and chmod files they did not create (CHOWN,
 * FOWNER); KILL lets the runtime end a hook's process group when part of it
 * runs as another user, such as apt's fetchers.
 */
export const DOCKER_SANDBOX_CAPABILITIES = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "KILL",
  "SETGID",
  "SETUID",
] as const;

/**
 * The sandbox reaches the control plane on the Docker network, not at its
 * public URL. The lifecycle manager builds the callback URL and every
 * control-plane-routed MCP proxy URL (personal and managed servers) from the
 * public URL, so both are moved to the network URL here. Only URLs under the
 * public control-plane URL are rewritten; a direct remote server keeps its own.
 */
export function sandboxFacingConfig(
  config: CreateSandboxConfig,
  networkControlPlaneUrl: string | undefined
): CreateSandboxConfig {
  if (!networkControlPlaneUrl) return config;
  const publicBase = config.controlPlaneUrl.replace(/\/+$/, "");
  const networkBase = networkControlPlaneUrl.replace(/\/+$/, "");
  const mcpServers = config.mcpServers?.map((server) => {
    if (server.type !== "remote" || typeof server.url !== "string") return server;
    if (server.url !== publicBase && !server.url.startsWith(`${publicBase}/`)) return server;
    return { ...server, url: `${networkBase}${server.url.slice(publicBase.length)}` };
  });
  return {
    ...config,
    controlPlaneUrl: networkControlPlaneUrl,
    ...(mcpServers ? { mcpServers } : {}),
  };
}

export interface DockerProviderConfig {
  image: string;
  network: string;
  deploymentName: string;
  controlPlaneUrl?: string;
  scmProvider: SourceControlProviderName;
  portal: DockerPortalConfig;
  sandboxAccessPasswordSecret: string;
  limits: DockerSandboxLimits;
  admission: DockerAdmission;
}

class DockerApiError extends SandboxProviderError {
  constructor(
    readonly status: number,
    operation: string
  ) {
    // Engine response bodies may contain container configuration. Do not log them.
    super(
      `Docker Engine ${operation} failed (HTTP ${status})`,
      status >= 500 ? "transient" : "permanent"
    );
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";
  readonly capabilities = {
    supportsSandboxTimeout: false,
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly transport: DockerTransport,
    private readonly config: DockerProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    if (config.prebuiltImageId) {
      throw new PrebuiltImageUnavailableError("Docker does not support prebuilt repository images");
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.sandboxId)) {
      throw new SandboxProviderError("Invalid Docker sandbox ID", "permanent");
    }
    const name = `openinspect-${config.sandboxId}`;
    const plan = resolveSandboxPortPlan(
      {
        codeServer: config.codeServerEnabled === true,
        terminal: config.sandboxSettings?.terminalEnabled === true,
        vnc: config.vncEnabled === true,
      },
      config.sandboxSettings
    );
    const portalToken = newDockerPortalToken();
    const access = await this.portalAccess(config.sandboxId, portalToken, plan);
    const labels = {
      [DOCKER_LABELS.framework]: "open-inspect",
      [DOCKER_LABELS.sessionId]: config.sessionId,
      [DOCKER_LABELS.sandboxId]: config.sandboxId,
      [DOCKER_LABELS.deployment]: this.config.deploymentName,
      [DOCKER_LABELS.kind]: "session",
      ...dockerPortalLabels(portalToken, plan),
    };
    const env = buildSandboxEnvVars(sandboxFacingConfig(config, this.config.controlPlaneUrl), {
      scmIdentity: scmCloneIdentity(this.config.scmProvider),
      portPlan: plan,
      codeServerPassword: access.codeServerPassword,
      vncPassword: access.vncAccess?.password,
      emitDisabledTerminalEnv: true,
    });
    Object.assign(env, {
      OI_DEFERRED_START: "false",
      IMAGE_BUILD_MODE: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      REPO_IMAGE_SHA: "",
      // This provider's callbacks stay on the operator-configured Docker network.
      OI_ALLOW_HTTP_CONTROL_PLANE: "true",
      OPENINSPECT_DOCKER_ENABLED: "false",
      // The runtime fetches the committed URL map before running start.sh.
      EXPECTED_TUNNEL_PORTS: plan.extraTunnelPorts.join(","),
    });
    return this.config.admission.admit(() =>
      this.createAndStart(config, name, env, labels, access)
    );
  }

  private async createAndStart(
    config: CreateSandboxConfig,
    name: string,
    env: Record<string, string>,
    labels: Record<string, string>,
    access: Awaited<ReturnType<DockerSandboxProvider["portalAccess"]>>
  ): Promise<CreateSandboxResult> {
    const { limits } = this.config;
    let containerId: string | undefined;
    try {
      const created = await this.call(
        "POST",
        `/containers/create?name=${encodeURIComponent(name)}&platform=linux%2Famd64`,
        [201],
        {
          Image: this.config.image,
          Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
          Labels: labels,
          // Override image defaults: PID 1 ultimately execs the standard runtime.
          Entrypoint: ["/bin/bash", "/app/docker-launcher.sh"],
          Cmd: [],
          WorkingDir: "/workspace",
          HostConfig: {
            NetworkMode: this.config.network,
            Init: true,
            AutoRemove: false,
            RestartPolicy: { Name: "no" },
            LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
            CapDrop: ["ALL"],
            CapAdd: [...DOCKER_SANDBOX_CAPABILITIES],
            SecurityOpt: ["no-new-privileges:true"],
            Memory: limits.memoryBytes,
            MemorySwap: limits.memorySwapBytes,
            NanoCpus: limits.nanoCpus,
            PidsLimit: limits.pidsLimit,
            ...(limits.runtime ? { Runtime: limits.runtime } : {}),
          },
        }
      );
      if (!isRecord(created) || typeof created.Id !== "string" || !created.Id) {
        throw new SandboxProviderError("Docker create did not return a container ID", "permanent");
      }
      containerId = created.Id;
      await this.call("POST", `${containerPath(containerId)}/start`, [204, 304]);
      // Docker start only confirms process launch. The lifecycle manager waits for
      // the authenticated bridge's runtime ready event before accepting work.
      return {
        sandboxId: config.sandboxId,
        providerObjectId: containerId,
        createdAt: Date.now(),
        lifetime: { kind: "none", observedAtMs: Date.now() },
        ...access,
      };
    } catch (error) {
      // A lost create response may still have allocated a container. Recover
      // its ID by deterministic name before cleanup, but never adopt a 409.
      if (!containerId && !(error instanceof DockerApiError)) {
        try {
          const detail = await this.call("GET", `${containerPath(name)}/json`, [200]);
          if (
            isRecord(detail) &&
            typeof detail.Id === "string" &&
            isRecord(detail.Config) &&
            isRecord(detail.Config.Labels)
          ) {
            const actualLabels = detail.Config.Labels;
            // The random portal token also proves this allocation attempt owns it.
            if (Object.entries(labels).every(([key, value]) => actualLabels[key] === value)) {
              containerId = detail.Id;
            }
          }
        } catch {
          log.warn("docker.create_allocation_unresolved", { container_name: name });
        }
      }
      if (containerId) {
        try {
          await this.call("DELETE", `${containerPath(containerId)}?force=true&v=true`, [204, 404]);
        } catch {
          log.warn("docker.create_cleanup_failed", { container_id: containerId });
        }
      }
      throw error;
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      const detail = await this.call(
        "GET",
        `${containerPath(config.providerObjectId)}/json`,
        [200]
      );
      if (
        !isRecord(detail) ||
        !isRecord(detail.Config) ||
        !isDockerSandbox(detail.Config.Labels, this.config.deploymentName) ||
        detail.Config.Labels[DOCKER_LABELS.sessionId] !== config.sessionId ||
        detail.Config.Labels[DOCKER_LABELS.sandboxId] !== config.sandboxId
      ) {
        throw new SandboxProviderError(
          "Docker container does not belong to this sandbox",
          "permanent"
        );
      }
      const portal = readDockerPortalLabels(detail.Config.Labels);
      // Containers created before portals keep their workspace and have no URLs.
      const access = portal
        ? await this.portalAccess(config.sandboxId, portal.token, portal.plan)
        : {};
      const start = () =>
        this.call("POST", `${containerPath(config.providerObjectId)}/start`, [204, 304]);
      // An already running container takes no new slot.
      if (isRecord(detail.State) && detail.State.Running === true) await start();
      else await this.config.admission.admit(start);
      return {
        success: true,
        providerObjectId: config.providerObjectId,
        lifetime: { kind: "none", observedAtMs: Date.now() },
        ...access,
      };
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) {
        return {
          success: false,
          shouldSpawnFresh: true,
          error: "Docker container no longer exists",
        };
      }
      throw error;
    }
  }

  private async portalAccess(sandboxId: string, token: string, plan: SandboxPortPlan) {
    const url = (port: number) => dockerPortalUrl(this.config.portal, token, port);
    const codeServerPassword =
      plan.codeServerPort !== undefined
        ? await deriveCodeServerPassword(sandboxId, this.config.sandboxAccessPasswordSecret)
        : undefined;
    const vncPassword =
      plan.vncPort !== undefined
        ? await deriveVncPassword(sandboxId, this.config.sandboxAccessPasswordSecret)
        : undefined;
    return {
      ...(plan.codeServerPort !== undefined
        ? { codeServerUrl: url(plan.codeServerPort), codeServerPassword }
        : {}),
      ...(plan.terminalPort !== undefined ? { ttydUrl: url(plan.terminalPort) } : {}),
      ...(plan.vncPort !== undefined
        ? { vncAccess: createVncAccess(url(plan.vncPort), vncPassword) }
        : {}),
      ...(plan.extraTunnelPorts.length
        ? {
            tunnelUrls: Object.fromEntries(
              plan.extraTunnelPorts.map((port) => [String(port), url(port)])
            ),
          }
        : {}),
    };
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const signal = signalUntilDeadline(config.deadlineAtMs, config.signal);
    const path = containerPath(config.providerObjectId);
    try {
      await this.call(
        "POST",
        `${path}/stop?t=${DOCKER_STOP_TIMEOUT_SECONDS}`,
        [204, 304],
        undefined,
        signal
      );
      if (config.intent === "destroy") {
        await this.call("DELETE", `${path}?force=true&v=true`, [204, 404], undefined, signal);
      } else {
        const detail = await this.call("GET", `${path}/json`, [200], undefined, signal);
        if (!isRecord(detail) || !isRecord(detail.State) || detail.State.Status !== "exited") {
          return { success: false, error: "Docker container did not reach the stopped state" };
        }
      }
      return { success: true };
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) {
        return config.intent === "destroy"
          ? { success: true }
          : { success: false, error: "Docker container disappeared before its stop was verified" };
      }
      throw error;
    }
  }

  private async call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    expected: number[],
    body?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    try {
      const response = await this.transport.request(method, path, body, signal);
      if (!expected.includes(response.status)) throw new DockerApiError(response.status, method);
      return response.body;
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      const code = isRecord(error) ? error.code : undefined;
      const permanent = code === "EACCES" || code === "ENOENT";
      throw new SandboxProviderError(
        permanent
          ? "Cannot access Docker socket; check DOCKER_SOCKET_PATH, its mount and socket group permissions"
          : "Docker Engine request failed or timed out; check the daemon and socket connection",
        permanent ? "permanent" : "transient"
      );
    }
  }
}

function containerPath(id: string): string {
  return `/containers/${encodeURIComponent(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
