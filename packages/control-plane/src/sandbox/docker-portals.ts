import { INTERNAL_TTYD_PORT, INTERNAL_VNC_PORT } from "@open-inspect/shared/types/integrations";
import type { EnvConfig } from "../types";
import type { SandboxPortPlan } from "./providers/port-resolution";

export const DOCKER_LABELS = {
  framework: "openinspect_framework",
  deployment: "openinspect_deployment",
  sessionId: "openinspect_session_id",
  sandboxId: "openinspect_expected_sandbox_id",
  kind: "openinspect_kind",
  portalToken: "openinspect_portal_token",
  allowedPorts: "openinspect_portal_allowed_ports",
  servicePorts: "openinspect_portal_service_ports",
} as const;

export const DEFAULT_DOCKER_PORTAL_PORT = 8790;
const PORTAL_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export interface DockerPortalConfig {
  port: number;
  baseDomain: string;
  publicPort: number;
  scheme: "http" | "https";
}

export function requireDockerSandboxNetwork(value: string | undefined): string {
  const network = value?.trim();
  if (
    !network ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network) ||
    network === "host" ||
    network === "none"
  ) {
    throw new Error(
      "DOCKER_SANDBOX_NETWORK must name a sandbox network, not host, none or a shared container namespace"
    );
  }
  return network;
}

export function resolveDockerPortalConfig(
  env: Pick<
    EnvConfig,
    | "DOCKER_PORTAL_PORT"
    | "DOCKER_PORTAL_BASE_DOMAIN"
    | "DOCKER_PORTAL_PUBLIC_PORT"
    | "DOCKER_PORTAL_SCHEME"
  >
): DockerPortalConfig {
  const baseDomain = env.DOCKER_PORTAL_BASE_DOMAIN?.trim().toLowerCase() || "localhost";
  // Leave space for the longest portal label and separator in a DNS hostname.
  if (
    baseDomain.length > 213 ||
    !baseDomain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^\d+(?:\.\d+){3}$/.test(baseDomain)
  ) {
    throw new Error("DOCKER_PORTAL_BASE_DOMAIN must be a DNS domain without scheme, port or path");
  }
  const scheme = env.DOCKER_PORTAL_SCHEME?.trim() || "http";
  if (scheme !== "http" && scheme !== "https") {
    throw new Error("DOCKER_PORTAL_SCHEME must be http or https");
  }
  return {
    baseDomain,
    scheme,
    port: configuredPort("DOCKER_PORTAL_PORT", env.DOCKER_PORTAL_PORT),
    publicPort: configuredPort("DOCKER_PORTAL_PUBLIC_PORT", env.DOCKER_PORTAL_PUBLIC_PORT),
  };
}

function configuredPort(name: string, value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return DEFAULT_DOCKER_PORTAL_PORT;
  if (!/^\d+$/.test(raw) || !validPort(Number(raw))) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return Number(raw);
}

export function newDockerPortalToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function dockerPortalUrl(config: DockerPortalConfig, token: string, port: number): string {
  return `${config.scheme}://p${port}-${token}.${config.baseDomain}:${config.publicPort}`;
}

/** Parse only a canonical portal authority, never a URL or a forwarding header. */
export function parseDockerPortalHost(
  host: string | undefined,
  config: DockerPortalConfig
): { token: string; port: number } | null {
  if (!host) return null;
  const domainSuffix = `.${config.baseDomain}`;
  const [hostname, publicPort, ...extra] = host.toLowerCase().split(":");
  if (extra.length || !hostname.endsWith(domainSuffix)) return null;
  if (
    publicPort !== undefined
      ? publicPort !== String(config.publicPort)
      : config.publicPort !== (config.scheme === "https" ? 443 : 80)
  )
    return null;
  const label = hostname.slice(0, -domainSuffix.length);
  const match = /^p([1-9]\d{0,4})-([a-f0-9]{32})$/.exec(label);
  return match && validPort(Number(match[1])) ? { token: match[2], port: Number(match[1]) } : null;
}

export function dockerPortalLabels(token: string, plan: SandboxPortPlan): Record<string, string> {
  return {
    [DOCKER_LABELS.portalToken]: token,
    [DOCKER_LABELS.allowedPorts]: JSON.stringify(plan.allExposedPorts),
    [DOCKER_LABELS.servicePorts]: JSON.stringify({
      codeServerPort: plan.codeServerPort,
      terminalPort: plan.terminalPort,
      vncPort: plan.vncPort,
    }),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDockerSandbox(
  labels: unknown,
  deploymentName: string
): labels is Record<string, unknown> {
  return (
    isRecord(labels) &&
    labels[DOCKER_LABELS.framework] === "open-inspect" &&
    labels[DOCKER_LABELS.deployment] === deploymentName &&
    typeof labels[DOCKER_LABELS.sessionId] === "string" &&
    !!labels[DOCKER_LABELS.sessionId] &&
    typeof labels[DOCKER_LABELS.sandboxId] === "string" &&
    !!labels[DOCKER_LABELS.sandboxId]
  );
}

/** Labels are immutable for a container. Resume uses the plan its runtime actually booted with. */
export function readDockerPortalLabels(
  labels: Record<string, unknown>
): { token: string; plan: SandboxPortPlan } | null {
  const token = labels[DOCKER_LABELS.portalToken];
  if (typeof token !== "string" || !PORTAL_TOKEN_PATTERN.test(token)) return null;
  try {
    const ports: unknown = JSON.parse(String(labels[DOCKER_LABELS.allowedPorts]));
    const services: unknown = JSON.parse(String(labels[DOCKER_LABELS.servicePorts]));
    if (
      !Array.isArray(ports) ||
      !ports.every(
        (port) => validPort(port) && port !== INTERNAL_TTYD_PORT && port !== INTERNAL_VNC_PORT
      ) ||
      new Set(ports).size !== ports.length ||
      !isRecord(services)
    )
      return null;
    const servicePlan: Pick<SandboxPortPlan, "codeServerPort" | "terminalPort" | "vncPort"> = {};
    for (const key of ["codeServerPort", "terminalPort", "vncPort"] as const) {
      const port = services[key];
      if (port === undefined) continue;
      if (!validPort(port) || !ports.includes(port)) return null;
      servicePlan[key] = port;
    }
    const reservedPorts = Object.values(servicePlan);
    if (new Set(reservedPorts).size !== reservedPorts.length) return null;
    return {
      token,
      plan: {
        ...servicePlan,
        reservedPorts,
        allExposedPorts: ports,
        extraTunnelPorts: ports.filter((port) => !reservedPorts.includes(port)),
      },
    };
  } catch {
    return null;
  }
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535;
}
