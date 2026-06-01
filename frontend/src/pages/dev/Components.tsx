import { Bell, Download, Plus, Settings, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ResponsiveMasterDetail } from "@/components/layout";
import {
  Alert,
  AppShell,
  Avatar,
  BackButton,
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Code,
  CommandPalette,
  Container,
  Divider,
  Drawer,
  EmptyState,
  FormField,
  Grid,
  Heading,
  Icon,
  IconButton,
  Inline,
  Input,
  Kbd,
  LinkButton,
  List,
  ListItem,
  Menu,
  Modal,
  NavItem,
  Pagination,
  Panel,
  ProgressBar,
  Radio,
  RoutedTabs,
  SearchInput,
  Select,
  SettingRow,
  Sidebar,
  Skeleton,
  Spinner,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  Tooltip,
  TopBar,
  useToast,
} from "@/components/ui";

/** A labelled section grouping related component demos. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="4">
      <Heading level={2}>{title}</Heading>
      <Panel padding="5">
        <Stack gap="5">{children}</Stack>
      </Panel>
    </Stack>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap="2">
      <Text size="sm" color="text-muted" weight="medium">
        {label}
      </Text>
      <Inline gap="3">{children}</Inline>
    </Stack>
  );
}

/**
 * Living component catalog / style guide. Mounted at `/dev/components` in dev
 * builds only. Renders every shared component across its variants/sizes/states,
 * plus a theme toggle that flips `[data-theme]` to prove token-driven theming.
 */
export function Components() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [checked, setChecked] = useState(true);
  const [switched, setSwitched] = useState(false);
  const [radio, setRadio] = useState("a");
  const [page, setPage] = useState(2);
  const [search, setSearch] = useState("");
  const [rmdDetail, setRmdDetail] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    return () => document.documentElement.removeAttribute("data-theme");
  }, [theme]);

  type DemoRow = { id: string; name: string; status: ReactNode };
  const rows: DemoRow[] = [
    {
      id: "1",
      name: "Acme Corp",
      status: <Badge variant="success">Active</Badge>,
    },
    {
      id: "2",
      name: "Globex",
      status: <Badge variant="warning">Pending</Badge>,
    },
    {
      id: "3",
      name: "Initech",
      status: <Badge variant="danger">Churned</Badge>,
    },
  ];

  return (
    <Container maxWidth="lg" style={{ paddingBlock: "var(--space-7)" }}>
      <Stack gap="7">
        <Inline justify="between" align="center">
          <Stack gap="1">
            <Heading level={1} variant="display">
              Component Catalog
            </Heading>
            <Text color="text-muted">
              Every shared primitive, all states - the token-driven style guide.
            </Text>
          </Stack>
          <Button
            variant="secondary"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          >
            Theme: {theme}
          </Button>
        </Inline>

        <Section title="Typography">
          <Stack gap="2">
            <Heading level={1}>Heading 1</Heading>
            <Heading level={2}>Heading 2</Heading>
            <Heading level={3}>Heading 3</Heading>
            <Heading level={4}>Heading 4</Heading>
            <Heading level={1} variant="display">
              Display title
            </Heading>
            <Text>Body text - the default paragraph size.</Text>
            <Text size="sm" color="text-muted">
              Small muted helper text.
            </Text>
            <Text>
              Inline <Code>code</Code> and a <Kbd>⌘</Kbd> <Kbd>K</Kbd> shortcut.
            </Text>
            <Code block>{`function hello() {\n  return "world";\n}`}</Code>
          </Stack>
        </Section>

        <Section title="Buttons & Icons">
          <Row label="Variants">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
          </Row>
          <Row label="Sizes">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
          </Row>
          <Row label="States & icons">
            <Button leftIcon={<Icon icon={Plus} size="sm" />}>With icon</Button>
            <Button loading>Loading</Button>
            <Button disabled>Disabled</Button>
            <IconButton
              label="Settings"
              icon={<Icon icon={Settings} size="md" />}
            />
            <IconButton
              label="Delete"
              variant="danger"
              icon={<Icon icon={Trash2} size="md" />}
            />
          </Row>
          <Row label="Back / cancel header (align: start = back, end = cancel)">
            <BackButton onClick={() => {}}>Back</BackButton>
            <BackButton align="end" size="md" onClick={() => {}}>
              Cancel
            </BackButton>
          </Row>
          <Row label="Link buttons (anchor styled as a button)">
            <LinkButton href="#" variant="primary">
              Primary link
            </LinkButton>
            <LinkButton href="#" variant="secondary">
              Secondary link
            </LinkButton>
            <LinkButton
              href="#"
              download
              variant="secondary"
              leftIcon={<Icon icon={Download} size="sm" />}
            >
              Download
            </LinkButton>
          </Row>
        </Section>

        <Section title="Form controls">
          <Grid columns={2} gap="5">
            <FormField label="Email" help="We'll never share it.">
              <Input type="email" placeholder="you@example.com" />
            </FormField>
            <FormField label="Password" required error="Password is too short.">
              <Input type="password" defaultValue="123" />
            </FormField>
            <FormField label="Bio">
              <Textarea placeholder="Tell us about yourself…" />
            </FormField>
            <FormField label="Role">
              <Select
                placeholder="Choose a role"
                options={[
                  { label: "Admin", value: "admin" },
                  { label: "Editor", value: "editor" },
                  { label: "Viewer", value: "viewer" },
                ]}
              />
            </FormField>
          </Grid>
          <Row label="Toggles">
            <Checkbox
              label="Checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <Switch
              label="Switch"
              checked={switched}
              onChange={(e) => setSwitched(e.target.checked)}
            />
            <Radio
              label="Option A"
              name="demo"
              value="a"
              checked={radio === "a"}
              onChange={() => setRadio("a")}
            />
            <Radio
              label="Option B"
              name="demo"
              value="b"
              checked={radio === "b"}
              onChange={() => setRadio("b")}
            />
          </Row>
          <FormField label="Search">
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={() => setSearch("")}
            />
          </FormField>
        </Section>

        <Section title="Overlays & feedback">
          <Row label="Triggers">
            <Button onClick={() => setModalOpen(true)}>Open modal</Button>
            <Button onClick={() => setDrawerOpen(true)}>Open drawer</Button>
            <Button onClick={() => setPaletteOpen(true)}>
              Open command palette
            </Button>
            <Tooltip content="Helpful hint">
              <Button variant="ghost">Hover me</Button>
            </Tooltip>
            <Menu
              label="Actions"
              trigger={<Button variant="secondary">Menu ▾</Button>}
              items={[
                { id: "edit", label: "Edit", onSelect: () => {} },
                { id: "dup", label: "Duplicate", onSelect: () => {} },
                {
                  id: "del",
                  label: "Delete",
                  danger: true,
                  onSelect: () => {},
                },
              ]}
            />
            <Button
              leftIcon={<Icon icon={Bell} size="sm" />}
              onClick={() =>
                toast({
                  title: "Saved",
                  description: "Your changes were saved.",
                  variant: "success",
                })
              }
            >
              Toast
            </Button>
          </Row>
          <Stack gap="3">
            <Banner variant="info" title="Heads up">
              An informational message.
            </Banner>
            <Banner variant="success" title="Success">
              Operation completed.
            </Banner>
            <Alert variant="warning" title="Warning">
              Double-check this.
            </Alert>
            <Banner variant="danger" title="Error">
              Something went wrong.
            </Banner>
          </Stack>
        </Section>

        <Section title="Status & data display">
          <Row label="Badges">
            <Badge>Neutral</Badge>
            <Badge variant="primary">Primary</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="danger" appearance="solid">
              Solid danger
            </Badge>
          </Row>
          <Row label="Avatars">
            <Avatar name="Ada Lovelace" size="sm" />
            <Avatar name="Grace Hopper" size="md" />
            <Avatar name="Mnemosyne Agent" size="lg" />
          </Row>
          <Row label="Loading">
            <Spinner size="sm" />
            <Spinner size="md" />
            <Spinner size="lg" />
            <Skeleton width="8rem" />
          </Row>
          <Stack gap="2">
            <ProgressBar value={40} label="Determinate progress" />
            <ProgressBar label="Indeterminate progress" />
          </Stack>
          <Table<DemoRow>
            caption="Accounts"
            columns={[
              { key: "name", header: "Name", render: (r) => r.name },
              {
                key: "status",
                header: "Status",
                render: (r) => r.status,
                align: "right",
              },
            ]}
            data={rows}
            getRowKey={(r) => r.id}
          />
          <Pagination page={page} pageCount={8} onPageChange={setPage} />
          <Tabs
            label="Demo tabs"
            tabs={[
              {
                id: "one",
                label: "Overview",
                content: <Text>Overview panel.</Text>,
              },
              {
                id: "two",
                label: "Details",
                content: <Text>Details panel.</Text>,
              },
              {
                id: "three",
                label: "Disabled",
                content: <Text>-</Text>,
                disabled: true,
              },
            ]}
          />
          {/* RoutedTabs is router-aware (each tab is a route). Wrapped in a
              self-contained MemoryRouter so the demo doesn't navigate the app. */}
          <MemoryRouter initialEntries={["/overview"]}>
            <Routes>
              <Route
                element={
                  <RoutedTabs
                    label="Routed tabs demo"
                    tabs={[
                      { label: "Overview", to: "overview" },
                      { label: "Details", to: "details", badge: 3 },
                      { label: "Activity", to: "activity" },
                    ]}
                  />
                }
              >
                <Route
                  path="overview"
                  element={<Text>Routed overview panel.</Text>}
                />
                <Route
                  path="details"
                  element={<Text>Routed details panel.</Text>}
                />
                <Route
                  path="activity"
                  element={<Text>Routed activity panel.</Text>}
                />
              </Route>
            </Routes>
          </MemoryRouter>
          <Card padding="4">
            <List>
              <ListItem trailing={<Badge variant="primary">New</Badge>}>
                First item
              </ListItem>
              <ListItem
                trailing={
                  <IconButton
                    label="Remove"
                    icon={<Icon icon={Trash2} size="sm" />}
                    size="sm"
                  />
                }
              >
                Second item
              </ListItem>
            </List>
          </Card>
          <Divider />
          <EmptyState
            icon={<Icon icon={Plus} size="lg" />}
            title="Nothing here yet"
            description="Empty states keep screens calm when there's no data."
            action={<Button>Create one</Button>}
          />
        </Section>

        <Section title="Layout - responsive master/detail">
          <Text size="sm" color="text-muted">
            Side-by-side at <Code>≥ md</Code>; below <Code>md</Code> it shows
            the master, then pushes the detail with a back control. Resize the
            window (narrow it past 768px) to see the push behavior.
          </Text>
          <ResponsiveMasterDetail
            masterWidth="14rem"
            showDetail={rmdDetail}
            onBack={() => setRmdDetail(false)}
            master={
              <Panel padding="4">
                <Stack gap="3">
                  <Heading level={4}>Master list</Heading>
                  <Button onClick={() => setRmdDetail(true)}>
                    Select an item
                  </Button>
                </Stack>
              </Panel>
            }
            detail={
              <Panel padding="4">
                <Text>Detail pane for the selected item.</Text>
              </Panel>
            }
          />
        </Section>

        <Section title="Application shell">
          <div
            style={{
              height: "20rem",
              overflow: "hidden",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--color-border)",
            }}
          >
            <AppShell
              topBar={
                <TopBar
                  title="Shell preview"
                  actions={<Avatar name="You" size="sm" />}
                />
              }
              sidebar={
                <Sidebar
                  header={<Heading level={4}>App</Heading>}
                  account={<Avatar name="Account" size="sm" />}
                >
                  <NavItem href="#" active>
                    Dashboard
                  </NavItem>
                  <NavItem href="#">Agents</NavItem>
                  <NavItem href="#">Reports</NavItem>
                </Sidebar>
              }
            >
              <Container style={{ paddingBlock: "var(--space-5)" }}>
                <Text>Main content area.</Text>
              </Container>
            </AppShell>
          </div>
        </Section>

        <Section title="Settings rows">
          <Panel padding="5">
            <Stack gap="4">
              <Heading level={3}>Profile details</Heading>
              <div>
                <SettingRow
                  label="Display name"
                  description="Shown across the app."
                  htmlFor="demo-setting-name"
                >
                  <Input id="demo-setting-name" defaultValue="Pedram" />
                </SettingRow>
                <SettingRow label="Email" description="Your primary address.">
                  <Inline justify="between" align="center">
                    <Text>pedram@smashlabs.com</Text>
                    <Button variant="secondary" size="sm">
                      Update
                    </Button>
                  </Inline>
                </SettingRow>
              </div>
            </Stack>
          </Panel>
        </Section>
      </Stack>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Example dialog"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setModalOpen(false)}>Confirm</Button>
          </>
        }
      >
        <Text>
          This modal traps focus, closes on Escape, and uses z-index tokens.
        </Text>
      </Modal>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Example drawer"
      >
        <Text>
          An edge-anchored panel sharing the same focus-trap behavior.
        </Text>
      </Drawer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={[
          {
            id: "new",
            group: "Actions",
            label: "Create agent",
            keywords: "add new",
            onSelect: () => {},
          },
          {
            id: "settings",
            group: "Actions",
            label: "Account settings",
            onSelect: () => {},
          },
          {
            id: "theme-dark",
            group: "Theme",
            label: "Theme: Dark",
            onSelect: () => {},
          },
          {
            id: "theme-light",
            group: "Theme",
            label: "Theme: Light",
            onSelect: () => {},
          },
        ]}
      />
    </Container>
  );
}
