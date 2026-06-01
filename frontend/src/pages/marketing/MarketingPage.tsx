import {
  ArrowRight,
  Brain,
  CalendarClock,
  Command as CommandIcon,
  Cpu,
  FileText,
  Info,
  type LucideIcon,
  Menu as MenuIcon,
  MessagesSquare,
  Moon,
  Palette,
  ScrollText,
  Signpost,
  Sparkles,
  Sun,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppearance } from "@/appearance/AppearanceProvider";
import { THEMES } from "@/appearance/appearance";
import {
  Badge,
  Button,
  Card,
  type CommandItem,
  CommandPalette,
  Divider,
  Drawer,
  Heading,
  Icon,
  IconButton,
  Inline,
  Kbd,
  Menu,
  type MenuItemSpec,
  NavItem,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./MarketingPage.module.css";
import { MemoryBrain } from "./MemoryConstellation";

/** In-page sections, in scroll order - drives the header nav + ⌘K jumps. */
const SECTIONS = [
  { id: "about", label: "About", icon: Info },
  { id: "features", label: "Features", icon: Sparkles },
  { id: "how", label: "How it works", icon: Workflow },
  { id: "roadmap", label: "Roadmap", icon: Signpost },
] as const;

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: Brain,
    title: "A living brain",
    body: "Every source, entity, and conclusion is written to a persistent memory graph that grows with each run - searchable, linkable, and never reset between sessions.",
  },
  {
    icon: Cpu,
    title: "Its own computer",
    body: "Each agent runs in an isolated cloud sandbox where it can browse, run code, and keep files between runs. A real workspace, not a chat box.",
  },
  {
    icon: Wrench,
    title: "Self-authored tools",
    body: "When an agent keeps hitting the same task, it writes and saves its own tool for it - getting sharper at your domain the longer it works.",
  },
  {
    icon: ScrollText,
    title: "A glass cockpit",
    body: "A streamable, filterable, searchable audit log of everything the agent did and why. Full transparency - never a black box.",
  },
  {
    icon: FileText,
    title: "Computed reports",
    body: "Agents synthesize findings into shareable reports with generated charts, on demand or on a schedule.",
  },
  {
    icon: Palette,
    title: "Yours to skin",
    body: "Six themes and ten typefaces, switchable live - this very page reskins with them. Press ⌘K and try one.",
  },
];

interface Step {
  n: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    n: "01",
    title: "Scope it",
    body: "Describe what you want tracked. Mnemosyne provisions an agent, its sandbox, and an empty brain.",
  },
  {
    n: "02",
    title: "Deep dive",
    body: "A multi-phase onboarding run seeds the brain with the lay of the land before you ask a single question.",
  },
  {
    n: "03",
    title: "Research on a cadence",
    body: "The agent works continuously - expanding its brain, chasing threads, and filing reports while you sleep.",
  },
  {
    n: "04",
    title: "It learns",
    body: "A periodic self-assessment lets the agent rewrite its own operating playbook, so it gets better at your domain over time.",
  },
];

interface RoadmapItem {
  icon: LucideIcon;
  title: string;
  body: string;
}

const ROADMAP: RoadmapItem[] = [
  {
    icon: CalendarClock,
    title: "Scheduled digests to your inbox",
    body: "Pick a cadence and have an agent's findings emailed to you, no tab required.",
  },
  {
    icon: MessagesSquare,
    title: "Talk to agents over SMS",
    body: "Message an agent like a colleague - including multi-agent group threads with floor control.",
  },
  {
    icon: Users,
    title: "Team workspaces",
    body: "Shared tenants so a whole team can run, read, and steer agents together.",
  },
];

/** Smooth-scroll to a section by id (header offset handled via scroll-margin). */
function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

/**
 * MarketingPage (`/`) - the public landing page. Standalone chrome (its own
 * header/footer, NOT the authed AppLayout), token-driven so it reskins with the
 * theme/typeface axes, with a ⌘K palette of its own (the app's
 * CommandPaletteProvider is auth-coupled, so this page carries a lightweight
 * palette of section jumps + appearance switches + sign-in). The app lives
 * behind /login; the CTAs route into it.
 */
export function MarketingPage() {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ⌘K / Ctrl+K toggles the marketing palette.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openApp = useCallback(() => navigate("/agents"), [navigate]);

  return (
    <div className={styles.page}>
      <MarketingHeader onOpenPalette={() => setPaletteOpen(true)} />

      <main>
        <Hero onOpenApp={openApp} />
        <About />
        <Features />
        <HowItWorks />
        <Roadmap />
        <CtaBand onOpenApp={openApp} />
      </main>

      <MarketingFooter />

      <MarketingPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenApp={openApp}
      />
    </div>
  );
}

/** Sticky top bar: brand, section nav, appearance menu, ⌘K, and the entry CTA. */
function MarketingHeader({ onOpenPalette }: { onOpenPalette: () => void }) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  // Mobile drawer actions close the drawer before navigating/scrolling.
  const jumpTo = useCallback((id: string) => {
    setMenuOpen(false);
    scrollToId(id);
  }, []);

  return (
    <header className={styles.header}>
      <div className={styles.container}>
        <div className={styles.headerInner}>
          <Button
            variant="link"
            className={styles.brandLink}
            aria-label="Mnemosyne — back to top"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          >
            <span className={styles.brandPill}>
              <span className={styles.brandGlyph} aria-hidden="true">
                🧠
              </span>
              <span className={styles.brandName}>Mnemosyne</span>
            </span>
          </Button>

          <nav className={styles.nav} aria-label="Sections">
            {SECTIONS.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 && (
                  <Divider
                    orientation="vertical"
                    className={styles.navDivider}
                  />
                )}
                <Button
                  variant="link"
                  leftIcon={<Icon icon={s.icon} size="sm" />}
                  onClick={() => scrollToId(s.id)}
                >
                  {s.label}
                </Button>
              </Fragment>
            ))}
          </nav>

          <Inline gap="2" align="center" wrap={false}>
            <AppearanceMenu />
            <span className={styles.cmdkButton}>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Icon icon={CommandIcon} size="sm" />}
                rightIcon={<Kbd>⌘K</Kbd>}
                onClick={onOpenPalette}
              >
                Search
              </Button>
            </span>
            <Button
              size="sm"
              rightIcon={<Icon icon={ArrowRight} size="sm" />}
              onClick={() => navigate("/login")}
            >
              Sign Up / In
            </Button>
            <span className={styles.menuButton}>
              <IconButton
                label="Open menu"
                size="sm"
                icon={<Icon icon={MenuIcon} size="sm" />}
                onClick={() => setMenuOpen(true)}
              />
            </span>
          </Inline>
        </div>
      </div>

      <Drawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        side="right"
        title="Menu"
      >
        <Stack gap="2">
          {SECTIONS.map((s) => (
            <NavItem
              key={s.id}
              as="button"
              icon={<Icon icon={s.icon} size="sm" />}
              onClick={() => jumpTo(s.id)}
            >
              {s.label}
            </NavItem>
          ))}
          <Divider />
          <Button
            fullWidth
            variant="secondary"
            leftIcon={<Icon icon={CommandIcon} size="sm" />}
            onClick={() => {
              setMenuOpen(false);
              onOpenPalette();
            }}
          >
            Search
          </Button>
          <Button
            fullWidth
            rightIcon={<Icon icon={ArrowRight} size="sm" />}
            onClick={() => {
              setMenuOpen(false);
              navigate("/login");
            }}
          >
            Sign Up / In
          </Button>
        </Stack>
      </Drawer>
    </header>
  );
}

/** Header theme picker - a Menu of the color themes (fonts live in ⌘K). */
function AppearanceMenu() {
  const { theme, setTheme } = useAppearance();
  const active = THEMES.find((t) => t.id === theme);
  const items: MenuItemSpec[] = THEMES.map((t) => ({
    id: t.id,
    label: t.label,
    icon: <Icon icon={t.mode === "dark" ? Moon : Sun} size="sm" />,
    onSelect: () => setTheme(t.id),
  }));
  return (
    <Menu
      align="end"
      label="Choose a theme"
      items={items}
      trigger={
        <IconButton
          label="Theme"
          size="sm"
          icon={<Icon icon={active?.mode === "dark" ? Moon : Sun} size="sm" />}
        />
      }
    />
  );
}

function Hero({ onOpenApp }: { onOpenApp: () => void }) {
  return (
    <section className={styles.hero}>
      <div className={styles.heroGlow} aria-hidden="true" />
      <div className={styles.container}>
        <Stack gap="5" align="center" className={styles.heroInner}>
          <Badge variant="primary" appearance="subtle">
            Self-serve research agents on a living memory
          </Badge>
          <Heading level={1} variant="display" className={styles.heroTitle}>
            Research that remembers
          </Heading>
          <Text size="lg" color="text-muted" className={styles.heroSub}>
            Mnemosyne gives every topic a tireless research agent with a memory
            that compounds - its own sandboxed computer, a living brain, and the
            tools it writes for itself.
          </Text>
          <Inline gap="3" align="center" wrap>
            <Button
              size="lg"
              rightIcon={<Icon icon={ArrowRight} size="sm" />}
              onClick={onOpenApp}
            >
              Open the app
            </Button>
            <Button
              size="lg"
              variant="secondary"
              onClick={() => scrollToId("about")}
            >
              What's a Mnemosyne?
            </Button>
          </Inline>
        </Stack>
      </div>
    </section>
  );
}

function About() {
  return (
    <section id="about" className={styles.section}>
      <div className={styles.container}>
        <div className={styles.aboutGrid}>
          <Stack gap="4" className={styles.prose}>
            <Badge variant="neutral" appearance="subtle">
              ne-MOSS-uh-nee · noun
            </Badge>
            <Heading level={2} variant="display">
              What's a Mnemosyne?
            </Heading>
            <Text size="lg" color="text-muted">
              In Greek myth, Mnemosyne is the Titaness of memory and mother of
              the nine Muses - every art and science was said to flow from her.
              The name is a bet: that intelligence is memory that compounds.
            </Text>
            <Text size="lg" color="text-muted">
              Most AI tools forget everything the moment a chat ends. A
              Mnemosyne agent does the opposite. Every fact it learns, every
              source it reads, every conclusion it draws becomes part of a brain
              it reasons over the next time you ask - so it starts each day
              knowing more than the last.
            </Text>
          </Stack>
          <div className={styles.constellation}>
            <MemoryBrain />
          </div>
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className={styles.section}>
      <div className={styles.container}>
        <Stack gap="6">
          <Stack gap="2">
            <Text size="sm" weight="semibold" className={styles.eyebrow}>
              Remember. Research. Report.
            </Text>
            <Heading level={2} variant="display">
              An agent that grows into the work
            </Heading>
          </Stack>
          <div className={styles.featureGrid}>
            {FEATURES.map((f) => (
              <Card key={f.title} padding="5" className={styles.featureCard}>
                <Stack gap="3">
                  <span className={styles.featureIcon}>
                    <Icon icon={f.icon} />
                  </span>
                  <Heading level={3} size="lg">
                    {f.title}
                  </Heading>
                  <Text color="text-muted">{f.body}</Text>
                </Stack>
              </Card>
            ))}
          </div>
        </Stack>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className={styles.section}>
      <div className={styles.container}>
        <Stack gap="6">
          <Heading level={2} variant="display">
            How an agent works
          </Heading>
          <div className={styles.stepGrid}>
            {STEPS.map((s) => (
              <Stack key={s.n} gap="2" className={styles.step}>
                <Text className={styles.stepNum}>{s.n}</Text>
                <Heading level={3} size="lg">
                  {s.title}
                </Heading>
                <Text color="text-muted">{s.body}</Text>
              </Stack>
            ))}
          </div>
        </Stack>
      </div>
    </section>
  );
}

function Roadmap() {
  return (
    <section id="roadmap" className={styles.section}>
      <div className={styles.container}>
        <Stack gap="6">
          <Stack gap="2">
            <Text size="sm" weight="semibold" className={styles.eyebrow}>
              On the roadmap
            </Text>
            <Heading level={2} variant="display">
              Where Mnemosyne is headed
            </Heading>
          </Stack>
          <div className={styles.roadmapGrid}>
            {ROADMAP.map((r) => (
              <Card key={r.title} padding="5" className={styles.featureCard}>
                <Stack gap="3">
                  <span className={styles.featureIcon}>
                    <Icon icon={r.icon} />
                  </span>
                  <Inline gap="2" align="center" wrap>
                    <Heading level={3} size="lg">
                      {r.title}
                    </Heading>
                    <Badge variant="neutral" appearance="subtle" size="sm">
                      Planned
                    </Badge>
                  </Inline>
                  <Text color="text-muted">{r.body}</Text>
                </Stack>
              </Card>
            ))}
          </div>
        </Stack>
      </div>
    </section>
  );
}

function CtaBand({ onOpenApp }: { onOpenApp: () => void }) {
  return (
    <section className={styles.ctaBand}>
      <div className={styles.container}>
        <Stack gap="4" align="center" className={styles.ctaInner}>
          <Heading level={2} variant="display" className={styles.ctaTitle}>
            Spin up your first agent
          </Heading>
          <Text size="lg" color="text-muted" className={styles.ctaSub}>
            Give it a topic. Come back to a brain that's been working without
            you.
          </Text>
          <Button
            size="lg"
            variant="secondary"
            rightIcon={<Icon icon={ArrowRight} size="sm" />}
            onClick={onOpenApp}
          >
            Open the app
          </Button>
        </Stack>
      </div>
    </section>
  );
}

/** Bottom-center attribution badge, theme-stylized, linking to Maestro. */
function MadeWithMaestro() {
  return (
    <div className={styles.maestroBar}>
      <NavItem
        href="https://runmaestro.ai"
        target="_blank"
        rel="noopener noreferrer"
        className={styles.maestroBadge}
        icon={
          <img
            src="https://runmaestro.ai/assets/icon.png"
            alt=""
            width={18}
            height={18}
            className={styles.maestroLogo}
          />
        }
      >
        Made with Maestro
      </NavItem>
    </div>
  );
}

function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.container}>
        <div className={styles.footerRow}>
          <Stack gap="1">
            <span className={styles.brand}>🧠 Mnemosyne</span>
            <Text size="sm" color="text-muted">
              Memory is the thesis.
            </Text>
          </Stack>
          <MadeWithMaestro />
          <Inline
            gap="2"
            align="center"
            wrap={false}
            className={styles.footerLocation}
          >
            <svg
              viewBox="0 0 3 2"
              width="21"
              height="14"
              role="img"
              aria-label="Texas"
              style={{ borderRadius: "2px", flexShrink: 0 }}
            >
              <rect width="3" height="2" fill="#ffffff" />
              <rect x="1" y="1" width="2" height="1" fill="#bf0a30" />
              <rect width="1" height="2" fill="#002868" />
              <path
                fill="#ffffff"
                d="M0.5 0.67 L0.576 0.895 L0.814 0.898 L0.624 1.04 L0.694 1.267 L0.5 1.13 L0.306 1.267 L0.376 1.04 L0.186 0.898 L0.424 0.895 Z"
              />
            </svg>
            <Text size="sm" color="text-muted">
              Built in Austin, TX
            </Text>
          </Inline>
        </div>
      </div>
    </footer>
  );
}

/** The marketing ⌘K palette: section jumps, appearance, and entry into the app. */
function MarketingPalette({
  open,
  onClose,
  onOpenApp,
}: {
  open: boolean;
  onClose: () => void;
  onOpenApp: () => void;
}) {
  const navigate = useNavigate();
  // Theme is switchable from the website; the typeface is locked to the Space
  // Grotesk brand face (PublicChrome), so no font items here.
  const { theme, setTheme, previewTheme, clearPreview } = useAppearance();

  const items = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [];

    for (const s of SECTIONS) {
      list.push({
        id: `jump-${s.id}`,
        group: "Jump to",
        label: s.label,
        keywords: `section scroll ${s.id}`,
        icon: <Icon icon={s.icon} size="sm" />,
        onSelect: () => scrollToId(s.id),
      });
    }

    list.push(
      {
        id: "open-app",
        group: "Get started",
        label: "Open the app",
        keywords: "launch agents dashboard",
        icon: <Icon icon={ArrowRight} size="sm" />,
        onSelect: onOpenApp,
      },
      {
        id: "sign-in",
        group: "Get started",
        label: "Sign up / in",
        keywords: "login signup account register",
        onSelect: () => navigate("/login"),
      },
    );

    for (const t of THEMES) {
      list.push({
        id: `theme-${t.id}`,
        group: "Theme",
        label: `Theme: ${t.label}`,
        keywords: `color appearance ${t.mode}`,
        icon: <Icon icon={t.mode === "dark" ? Moon : Sun} size="sm" />,
        hint:
          t.id === theme ? (
            <Badge variant="neutral" appearance="subtle" size="sm">
              Active
            </Badge>
          ) : undefined,
        onSelect: () => setTheme(t.id),
        onPreview: () => previewTheme(t.id),
      });
    }

    return list;
  }, [navigate, onOpenApp, theme, setTheme, previewTheme]);

  return (
    <CommandPalette
      open={open}
      onClose={onClose}
      items={items}
      onPreviewClear={clearPreview}
    />
  );
}
