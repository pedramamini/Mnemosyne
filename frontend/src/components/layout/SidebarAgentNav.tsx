import {
  ChevronDown,
  ChevronRight,
  FolderInput,
  FolderPlus,
} from "lucide-react";
import { type MouseEvent, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Agent } from "@/api/agents";
import { useAgents } from "@/components/dashboard/useAgentMetrics";
import {
  Avatar,
  Badge,
  Button,
  FormField,
  Icon,
  IconButton,
  Input,
  Menu,
  type MenuItemSpec,
  Modal,
  NavItem,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./SidebarAgentNav.module.css";
import { useAgentAvatars } from "./useAgentAvatars";
import { useAgentGroups } from "./useAgentGroups";

export interface SidebarAgentNavProps {
  /**
   * `"flyout"` renders a compact, read-only version (grouped + named + clickable
   * agents, no overflow menus or grouping modal) for the collapsed-rail
   * `SidebarFlyout`. `"default"` is the full expanded-sidebar nav.
   */
  variant?: "default" | "flyout";
}

/**
 * SidebarAgentNav - the per-agent quick-nav that lives under the top-level
 * "Agents" link in the shared sidebar. Lists the account's agents (reusing the
 * dashboard's `useAgents`), each linking to its detail page with active-route
 * highlighting, and organizes them into named, collapsible groups via
 * `useAgentGroups`. Each row's overflow menu moves the agent between groups (or
 * into a brand-new one). Built only from `@/components/ui` primitives.
 */
export function SidebarAgentNav({ variant = "default" }: SidebarAgentNavProps) {
  const navigate = useNavigate();
  const { agentId: activeId } = useParams();
  const { agents, loading, error } = useAgents();
  const { groupOf, groupNames, assign, isCollapsed, toggleCollapsed } =
    useAgentGroups();
  const { avatarOf } = useAgentAvatars();

  // New-group modal: which agent we're assigning + the typed name.
  const [newGroupFor, setNewGroupFor] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");

  // Partition agents (alphabetical) into their groups + the ungrouped rest.
  const { grouped, ungrouped } = useMemo(() => {
    const grouped = new Map<string, Agent[]>();
    const ungrouped: Agent[] = [];
    const sorted = [...(agents ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    for (const agent of sorted) {
      const group = groupOf(agent.id);
      if (group) {
        const list = grouped.get(group) ?? [];
        list.push(agent);
        grouped.set(group, list);
      } else {
        ungrouped.push(agent);
      }
    }
    return { grouped, ungrouped };
  }, [agents, groupOf]);

  const hasGroups = groupNames.length > 0;

  function goToAgent(id: string) {
    return (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      navigate(`/agents/${id}`);
    };
  }

  function openNewGroup(agentId: string) {
    setNewGroupName("");
    setNewGroupFor(agentId);
  }

  function confirmNewGroup() {
    const name = newGroupName.trim();
    if (newGroupFor && name) assign(newGroupFor, name);
    setNewGroupFor(null);
  }

  function renderAgent(agent: Agent) {
    return (
      <AgentRow
        key={agent.id}
        agent={agent}
        active={agent.id === activeId}
        avatarSrc={avatarOf(agent.id)}
        groupNames={groupNames}
        currentGroup={groupOf(agent.id)}
        onNavigate={goToAgent(agent.id)}
        onAssign={(group) => assign(agent.id, group)}
        onNewGroup={() => openNewGroup(agent.id)}
      />
    );
  }

  function renderFlyoutRow(agent: Agent) {
    return (
      <NavItem
        key={agent.id}
        href={`/agents/${agent.id}`}
        onClick={goToAgent(agent.id)}
        active={agent.id === activeId}
        icon={<Avatar name={agent.name} src={avatarOf(agent.id)} size="sm" />}
      >
        {agent.name}
      </NavItem>
    );
  }

  // Collapsed-rail flyout: grouped + named + clickable, no menus/modal. The
  // grouping affordances would be fragile inside a transient hover panel, so the
  // flyout is read-only navigation; group management stays in the expanded nav.
  if (variant === "flyout") {
    return (
      <Stack gap="1">
        {loading && (
          <div className={styles.state}>
            <Spinner size="sm" label="Loading agents" />
          </div>
        )}
        {error && !loading && (
          <Text size="sm" color="text-muted" className={styles.state}>
            Couldn't load agents.
          </Text>
        )}
        {!loading && !error && agents?.length === 0 && (
          <Text size="sm" color="text-muted" className={styles.state}>
            No agents yet.
          </Text>
        )}
        {groupNames.map((name) => {
          const list = grouped.get(name) ?? [];
          if (list.length === 0) return null;
          return (
            <div key={name}>
              <Text
                size="xs"
                weight="medium"
                color="text-muted"
                className={styles.flyoutGroup}
              >
                {name}
              </Text>
              <Stack gap="1">{list.map(renderFlyoutRow)}</Stack>
            </div>
          );
        })}
        {ungrouped.map(renderFlyoutRow)}
      </Stack>
    );
  }

  return (
    <Stack gap="1" className={styles.root}>
      <Text
        size="xs"
        weight="medium"
        color="text-muted"
        className={styles.label}
      >
        Your agents
      </Text>

      {loading && (
        <div className={styles.state}>
          <Spinner size="sm" label="Loading agents" />
        </div>
      )}
      {error && !loading && (
        <Text size="sm" color="text-muted" className={styles.state}>
          Couldn't load agents.
        </Text>
      )}
      {!loading && !error && agents?.length === 0 && (
        <Text size="sm" color="text-muted" className={styles.state}>
          No agents yet.
        </Text>
      )}

      {/* Grouped agents - each group is collapsible. */}
      {groupNames.map((name) => {
        const list = grouped.get(name) ?? [];
        const collapsed = isCollapsed(name);
        return (
          <div key={name}>
            <div className={styles.groupHeader}>
              <IconButton
                label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
                icon={
                  <Icon
                    icon={collapsed ? ChevronRight : ChevronDown}
                    size="sm"
                  />
                }
                size="sm"
                aria-expanded={!collapsed}
                onClick={() => toggleCollapsed(name)}
              />
              <Text
                size="sm"
                weight="medium"
                truncate
                className={styles.groupName}
                title={name}
              >
                {name}
              </Text>
              <Badge variant="neutral" appearance="subtle" size="sm">
                {list.length}
              </Badge>
            </div>
            {!collapsed && (
              <Stack gap="1" className={styles.groupItems}>
                {list.map(renderAgent)}
              </Stack>
            )}
          </div>
        );
      })}

      {/* Ungrouped agents - labeled only when at least one group exists. */}
      {ungrouped.length > 0 && (
        <>
          {hasGroups && (
            <div className={styles.groupHeader}>
              <span className={styles.chevronSpacer} aria-hidden="true" />
              <Text
                size="sm"
                weight="medium"
                color="text-muted"
                className={styles.groupName}
              >
                Ungrouped
              </Text>
              <Badge variant="neutral" appearance="subtle" size="sm">
                {ungrouped.length}
              </Badge>
            </div>
          )}
          <Stack gap="1" className={hasGroups ? styles.groupItems : undefined}>
            {ungrouped.map(renderAgent)}
          </Stack>
        </>
      )}

      <Modal
        open={newGroupFor !== null}
        onClose={() => setNewGroupFor(null)}
        title="New group"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNewGroupFor(null)}>
              Cancel
            </Button>
            <Button
              onClick={confirmNewGroup}
              disabled={newGroupName.trim() === ""}
            >
              Create group
            </Button>
          </>
        }
      >
        <FormField label="Group name">
          <Input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmNewGroup();
            }}
            placeholder="e.g. Real estate"
            autoFocus
          />
        </FormField>
      </Modal>
    </Stack>
  );
}

interface AgentRowProps {
  agent: Agent;
  active: boolean;
  avatarSrc?: string;
  groupNames: string[];
  currentGroup: string | null;
  onNavigate: (e: MouseEvent<HTMLAnchorElement>) => void;
  onAssign: (group: string | null) => void;
  onNewGroup: () => void;
}

/** One agent row: an avatar+name link plus an overflow menu of grouping actions. */
function AgentRow({
  agent,
  active,
  avatarSrc,
  groupNames,
  currentGroup,
  onNavigate,
  onAssign,
  onNewGroup,
}: AgentRowProps) {
  const items: MenuItemSpec[] = [
    ...groupNames
      .filter((g) => g !== currentGroup)
      .map((g) => ({
        id: `move:${g}`,
        label: `Move to "${g}"`,
        icon: <Icon icon={FolderInput} size="sm" />,
        onSelect: () => onAssign(g),
      })),
    {
      id: "new-group",
      label: "New group…",
      icon: <Icon icon={FolderPlus} size="sm" />,
      onSelect: onNewGroup,
    },
    ...(currentGroup
      ? [
          {
            id: "remove",
            label: "Remove from group",
            onSelect: () => onAssign(null),
          },
        ]
      : []),
  ];

  return (
    <div className={styles.agentRow}>
      <NavItem
        href={`/agents/${agent.id}`}
        onClick={onNavigate}
        active={active}
        icon={<Avatar name={agent.name} src={avatarSrc} size="sm" />}
        className={styles.agentLink}
      >
        {agent.name}
      </NavItem>
      <span className={styles.agentMenu}>
        <Menu
          align="end"
          label={`Grouping options for ${agent.name}`}
          trigger={
            <IconButton
              label={`Grouping options for ${agent.name}`}
              icon={
                <Text aria-hidden="true" weight="bold">
                  ⋯
                </Text>
              }
              size="sm"
            />
          }
          items={items}
        />
      </span>
    </div>
  );
}
