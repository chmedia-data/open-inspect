"use client";

import { useCallback, useState, useMemo } from "react";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { useResourceTeams } from "@/hooks/use-resource-teams";
import { ResourceTeamField } from "@/components/resource-team-field";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { reconcileProviderSelectionsForHarness } from "@open-inspect/shared/harnesses";
import { resolveHarnessModelSelection } from "@/lib/session-harness";
import { SUBSCRIPTION_PROVIDER_IDS } from "@open-inspect/shared/types/provider-accounts";
import { MAX_AUTOMATION_NAME_LENGTH } from "@open-inspect/shared/types/automations";
import { useProviderAccounts } from "@/hooks/use-provider-accounts";
import { ProviderAuthControls } from "@/components/provider-auth-controls";
import { setProviderSelection } from "@/lib/provider-selection";
import { FieldDescription } from "./automation-form-field";
import {
  McpServerPicker,
  isPersonalMcpServer,
  mcpPickerServers,
} from "@/components/mcp-server-picker";
import { useMcpConnectionStatus, useMcpServers } from "@/hooks/use-mcp-servers";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useAuthSession } from "@/lib/auth-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAutomationTargets } from "./use-automation-targets";
import { sameEnvironmentIds } from "./automation-target-selection";
import { AutomationAgentFields } from "./automation-agent-fields";
import { AutomationTargetPicker } from "./automation-target-picker";
import { AutomationInstructionsField } from "./automation-instructions-field";
import {
  AutomationTriggerConfigurationFields,
  AutomationTriggerTypeField,
} from "./automation-trigger-fields";
import {
  createAutomationFormDraft,
  evaluateAutomationForm,
  automationOwnerSelectable,
  requiresRepositoryContext,
  withoutOwnerBoundConditions,
  type AutomationAgentDraft,
  type AutomationFormValues,
} from "./automation-form-policy";

export type { AutomationFormValues } from "./automation-form-policy";

interface AutomationFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<AutomationFormValues>;
  onSubmit: (values: AutomationFormValues) => void;
  submitting: boolean;
  requireTeam?: boolean;
  /** The automation's owner when editing; personal MCP servers act as them. */
  ownerUserId?: string | null;
}

export function AutomationForm({
  mode,
  initialValues,
  onSubmit,
  submitting,
  requireTeam = false,
  ownerUserId,
}: AutomationFormProps) {
  const [teamId, setTeamId] = useState(initialValues?.teamId ?? null);
  const scope = useResourceTeams("automation");
  const allowWorkspace = scope.allowWorkspace && !requireTeam;
  const scopeValid = mode === "edit" || automationOwnerSelectable(teamId, scope, requireTeam);
  const { repos, loading: loadingRepos } = useRepos(true, teamId);
  const { environments, loading: loadingEnvironments } = useEnvironments({ ownerTeamId: teamId });
  const { enabledModels, enabledModelOptions, loading: loadingModels } = useEnabledModels();
  const providerAccounts = useProviderAccounts();
  const initialDraft = useMemo(() => createAutomationFormDraft(initialValues), [initialValues]);
  const initialRepositories = useMemo(
    () => initialValues?.repositories ?? [],
    [initialValues?.repositories]
  );

  const [name, setName] = useState(initialDraft.name);
  const [providerSelections, setProviderSelections] = useState(initialDraft.providerSelections);
  const [agent, setAgent] = useState(initialDraft.agent);
  const [instructions, setInstructions] = useState(initialDraft.instructions);
  const [trigger, setTrigger] = useState(initialDraft.trigger);
  const repositoryRequired = requiresRepositoryContext(trigger.type);

  const isSchedule = trigger.type === "schedule";
  // Multi-repository selections are schedule-only (the server rejects them for
  // event triggers), so the mode toggle only exists there.
  const multiRepoAllowed = isSchedule;

  const targets = useAutomationTargets({
    initialRepositories,
    initialEnvironmentIds: initialValues?.environmentIds ?? [],
    multiRepoAllowed,
    repositoryRequired,
    repos,
  });
  const { selectedEnvironmentIds, buildRepositoriesPayload } = targets;

  const [mcpServerIds, setMcpServerIds] = useState<string[]>(initialValues?.mcpServerIds ?? []);
  const { servers: mcpServers } = useMcpServers();
  const mcpConnectionStatus = useMcpConnectionStatus();
  const { hasPermission } = useCurrentUserAuthorization();
  const { data: authSession } = useAuthSession();
  const isOwner = mode === "create" || (!!ownerUserId && ownerUserId === authSession?.user?.id);
  // Mirrors the control plane's save-time rules (routes/automation-mcp.ts), which stay the authority.
  const personalMcpDisabledReason = !hasPermission("mcp_connections.use")
    ? "Personal servers need the mcp_connections.use permission."
    : teamId !== null
      ? "Team automations cannot use personal servers; use a server with shared credentials."
      : trigger.type !== "schedule"
        ? "Only scheduled automations can use personal servers."
        : !isOwner
          ? "Only the automation's owner can add personal servers."
          : null;
  const ownerLocked =
    !isOwner &&
    (initialValues?.mcpServerIds ?? []).some((id) =>
      mcpServers.some((server) => server.id === id && isPersonalMcpServer(server))
    );
  const environmentsUsable =
    (mode === "edit" &&
      sameEnvironmentIds(selectedEnvironmentIds, initialValues?.environmentIds ?? [])) ||
    selectedEnvironmentIds.length === 0 ||
    (!loadingEnvironments &&
      selectedEnvironmentIds.every((id) =>
        environments.some(
          (environment) => environment.id === id && environment.capabilities?.canUse === true
        )
      ));

  // The model we display and submit, and whether it may be submitted. The
  // selector only lists enabled models the harness can run, so a disabled
  // default (blank create), a disabled saved model (edit), a disabled template
  // suggestion, or a model the harness cannot run is coerced to a listed one.
  // Until preferences load we can't know the enabled set, so the selection
  // stands and submit is blocked; when the harness can run none of the enabled
  // models the form says so and blocks too — keeping display, reasoning, and
  // the payload in agreement without relying on a post-load effect.
  const modelSelection = useMemo(
    () =>
      resolveHarnessModelSelection({
        harness: agent.harness,
        preference: { model: agent.model },
        enabledModels,
        enabledModelOptions,
        loading: loadingModels,
      }),
    [agent.harness, agent.model, enabledModelOptions, enabledModels, loadingModels]
  );
  const resolvedModel = modelSelection.model;
  const modelError =
    modelSelection.availability.status === "unavailable" ? modelSelection.availability.message : "";

  // A harness switch drops pins the new harness cannot honour, so the form
  // never offers to save a configuration the server would refuse.
  const handleAgentChange = useCallback((next: AutomationAgentDraft) => {
    setAgent(next);
    setProviderSelections((current) =>
      reconcileProviderSelectionsForHarness(next.harness, current)
    );
  }, []);

  const formEvaluation = evaluateAutomationForm({
    mode,
    originalTrigger: initialDraft.trigger,
    originalScheduleOnceAt: initialValues?.scheduleOnceAt,
    modelAvailability: modelSelection.availability,
    resolvedModel,
    draft: {
      name,
      instructions,
      providerSelections,
      agent,
      trigger,
    },
    targets: {
      repositories: buildRepositoriesPayload(),
      environmentIds: selectedEnvironmentIds,
    },
  });
  const conditionErrors =
    !formEvaluation.valid && formEvaluation.reason === "invalid-conditions"
      ? formEvaluation.conditionErrors
      : [];
  const eventTypeError =
    !formEvaluation.valid && formEvaluation.reason === "event-type-required"
      ? "Event type is required."
      : "";
  const slackChannelError =
    !formEvaluation.valid && formEvaluation.reason === "slack-channel-required"
      ? "Slack triggers require at least one Slack Channel condition."
      : "";
  const slackBotAllowListError =
    !formEvaluation.valid && formEvaluation.reason === "slack-bot-allow-list-required"
      ? "Add a Slack User condition that includes the bots allowed to trigger this automation."
      : "";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formEvaluation.valid || !scopeValid || !environmentsUsable || ownerLocked || submitting)
      return;
    onSubmit({
      ...formEvaluation.values,
      mcpServerIds,
      ...(mode === "create" ? { teamId } : {}),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <ResourceTeamField
        {...scope}
        teamId={teamId}
        disabled={submitting || mode === "edit"}
        allowWorkspace={mode === "edit" || allowWorkspace}
        onChange={(nextTeamId) => {
          if (submitting || mode === "edit") return;
          setTeamId(nextTeamId);
          targets.resetTargets();
          setTrigger((current) => ({
            ...current,
            conditions: withoutOwnerBoundConditions(current.conditions),
          }));
        }}
      />
      <AutomationTriggerTypeField mode={mode} value={trigger} onChange={setTrigger} />

      {/* Name */}
      <div>
        <label
          htmlFor="automation-name"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Name
        </label>
        <Input
          id="automation-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isSchedule ? "Daily code review" : "Review new PRs"}
          maxLength={MAX_AUTOMATION_NAME_LENGTH}
          required
        />
      </div>

      <AutomationTargetPicker
        targets={targets}
        repos={repos}
        environments={environments}
        loadingRepos={loadingRepos}
        loadingEnvironments={loadingEnvironments}
        multiTargetAllowed={multiRepoAllowed}
        repositoryRequired={repositoryRequired}
      />

      <AutomationAgentFields
        value={agent}
        resolvedModel={resolvedModel}
        enabledModelOptions={modelSelection.options}
        modelError={modelError}
        onChange={handleAgentChange}
      />

      <fieldset className="space-y-3 rounded-md border border-border-muted p-4">
        <legend className="px-1 text-sm font-medium text-foreground">
          Provider authentication
        </legend>
        <FieldDescription className="mb-3">
          Unpinned providers use defaults when each run starts. Pins are retained when the
          configured model changes and apply only to future sessions.
        </FieldDescription>
        {SUBSCRIPTION_PROVIDER_IDS.map((provider) => (
          <ProviderAuthControls
            key={provider}
            provider={provider}
            harness={agent.harness}
            accounts={providerAccounts.accounts}
            defaultValue={providerAccounts.defaults.find((item) => item.provider === provider)}
            value={providerSelections[provider]}
            policyLabel="Use defaults when each run starts"
            unattended
            disabled={submitting}
            onChange={(selection) =>
              setProviderSelections((current) => setProviderSelection(current, provider, selection))
            }
          />
        ))}
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-border-muted p-4">
        <legend className="px-1 text-sm font-medium text-foreground">MCP servers</legend>
        <FieldDescription className="mb-3">
          Servers each run&apos;s sandbox runs. None are selected by default. Personal servers act
          as the automation&apos;s owner.
        </FieldDescription>
        <McpServerPicker
          servers={mcpPickerServers(
            mcpServers,
            buildRepositoriesPayload().map((repo) => `${repo.repoOwner}/${repo.repoName}`),
            mcpServerIds
          )}
          connectionStatus={mcpConnectionStatus}
          value={mcpServerIds}
          onChange={(next) => setMcpServerIds(next ?? [])}
          personalDisabledReason={personalMcpDisabledReason}
          disabled={submitting || ownerLocked}
        />
      </fieldset>

      <AutomationTriggerConfigurationFields
        key={trigger.type}
        mode={mode}
        value={trigger}
        onChange={setTrigger}
        eventTypeError={eventTypeError}
        slackChannelError={slackChannelError}
        slackBotAllowListError={slackBotAllowListError}
        conditionErrors={conditionErrors}
      />

      <AutomationInstructionsField
        value={instructions}
        triggerType={trigger.type}
        onChange={setInstructions}
      />

      {ownerLocked && (
        <p className="text-sm text-muted-foreground" role="status">
          This automation uses its owner&apos;s personal MCP servers, so only its owner can change
          it. You can still pause it.
        </p>
      )}

      {/* Submit */}
      <div className="flex justify-end gap-2">
        <Button
          type="submit"
          disabled={
            submitting || !formEvaluation.valid || !scopeValid || !environmentsUsable || ownerLocked
          }
        >
          {submitting
            ? mode === "create"
              ? "Creating..."
              : "Saving..."
            : mode === "create"
              ? "Create Automation"
              : "Save Changes"}
        </Button>
      </div>
    </form>
  );
}
