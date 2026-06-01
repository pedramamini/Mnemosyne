import { Palette, User } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { type OwnerProfile, updateProfile } from "@/api/auth";
import { useSession } from "@/auth/useSession";
import { ResponsiveMasterDetail } from "@/components/layout";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  Banner,
  Button,
  Heading,
  Icon,
  Inline,
  Input,
  NavItem,
  Page,
  Panel,
  Select,
  type SelectOption,
  SettingRow,
  Stack,
  Text,
  Textarea,
} from "@/components/ui";
import { AppearanceSettingsSection } from "./AppearanceSettingsTab";

/** Field caps mirror the backend validation (src/account/routes.ts). */
const NAME_MAX = 200;
const NOTES_MAX = 4000;

/** Fallback list when the runtime lacks `Intl.supportedValuesOf` (rare). */
const COMMON_ZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** All IANA zones from the runtime's ICU data, or the curated fallback. */
function allTimeZones(): string[] {
  const supported = (
    Intl as unknown as {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;
  return supported ? supported("timeZone") : COMMON_ZONES;
}

/** The browser's best guess at the user's zone, for the "use detected" hint. */
function detectedTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Timezone <Select> options: a leading "UTC (default)" (empty value) then every
 * IANA zone. A non-empty `current` that isn't in the list (e.g. an alias) is
 * prepended so the saved value always round-trips in the control.
 */
function timeZoneOptions(current: string | null): SelectOption[] {
  const base = allTimeZones();
  const zones =
    current && !base.includes(current) ? [current, ...base] : [...base];
  return [
    { label: "UTC (default)", value: "" },
    ...zones.map((z) => ({ label: z.replace(/_/g, " "), value: z })),
  ];
}

type SaveState = "idle" | "saving" | "saved" | "error";

interface FormState {
  name: string;
  timezone: string;
  notes: string;
}

function toForm(profile: OwnerProfile | undefined): FormState {
  return {
    name: profile?.name ?? "",
    timezone: profile?.timezone ?? "",
    notes: profile?.notes ?? "",
  };
}

/**
 * The owner-profile form (split out from the page so it tests without the full
 * app shell). Prefills from the session's account, PUTs the profile on save, and
 * re-probes the session so the updated profile propagates app-wide. Empty
 * strings are sent as `null` (clearing the field / falling back to UTC).
 */
export function AccountSettingsForm() {
  const { account, refresh } = useSession();
  const [form, setForm] = useState<FormState>(() => toForm(account?.profile));
  const [save, setSave] = useState<SaveState>("idle");

  const tzOptions = useMemo(
    () => timeZoneOptions(account?.profile.timezone ?? null),
    [account?.profile.timezone],
  );
  const detected = useMemo(detectedTimeZone, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSave("idle");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSave("saving");
    try {
      await updateProfile({
        name: form.name.trim() === "" ? null : form.name.trim(),
        timezone: form.timezone === "" ? null : form.timezone,
        notes: form.notes.trim() === "" ? null : form.notes,
      });
      // Re-probe /api/me so every agent's view of the profile stays in sync.
      await refresh();
      setSave("saved");
    } catch {
      setSave("error");
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <Stack gap="4">
        {save === "saved" && (
          <Banner variant="success" title="Saved">
            Your agents now use these settings.
          </Banner>
        )}
        {save === "error" && (
          <Banner variant="danger" title="Couldn't save">
            Something went wrong saving your profile. Please try again.
          </Banner>
        )}

        <div>
          <SettingRow
            label="Your name"
            description="How your agents address you in chat and reports."
            htmlFor="settings-name"
          >
            <Input
              id="settings-name"
              value={form.name}
              maxLength={NAME_MAX}
              placeholder="e.g. Pedram"
              onChange={(e) => set("name", e.target.value)}
            />
          </SettingRow>

          <SettingRow
            label="Timezone"
            description="Agents show dates and times in this zone. Defaults to UTC."
            htmlFor="settings-timezone"
          >
            <Stack gap="2">
              <Select
                id="settings-timezone"
                value={form.timezone}
                options={tzOptions}
                onChange={(e) => set("timezone", e.target.value)}
              />
              {detected && detected !== form.timezone && (
                <Inline gap="2" align="center">
                  <Text size="sm" color="text-muted">
                    Detected: {detected.replace(/_/g, " ")}
                  </Text>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => set("timezone", detected)}
                  >
                    Use this
                  </Button>
                </Inline>
              )}
            </Stack>
          </SettingRow>

          <SettingRow
            label="About you"
            description="How you like to work and what you're trying to achieve - your agents keep this in mind on every run."
            htmlFor="settings-notes"
          >
            <Textarea
              id="settings-notes"
              value={form.notes}
              maxLength={NOTES_MAX}
              rows={6}
              placeholder="e.g. Direct, no fluff. I care about security research; surface risks early and cite sources."
              onChange={(e) => set("notes", e.target.value)}
            />
          </SettingRow>
        </div>

        <Inline justify="end">
          <Button type="submit" loading={save === "saving"}>
            Save changes
          </Button>
        </Inline>
      </Stack>
    </form>
  );
}

type SettingsSection = "profile" | "appearance";

/**
 * AccountSettingsPage (`/settings`) - master/detail account settings: a left
 * sub-nav (Profile / Appearance) drives the right panel. Profile fields are
 * account-wide (a save applies to every agent the account runs); appearance is
 * per-device. On narrow viewports the nav and the panel become a one-pane push
 * (via {@link ResponsiveMasterDetail}). Add a section = a nav item + a panel.
 */
export function AccountSettingsPage() {
  const [active, setActive] = useState<SettingsSection>("profile");
  // Mobile push: the nav shows first, tapping a section pushes its panel.
  const [showDetail, setShowDetail] = useState(false);

  function select(section: SettingsSection) {
    setActive(section);
    setShowDetail(true);
  }

  const nav = (
    <Stack gap="5">
      <Heading level={1} variant="display">
        Settings
      </Heading>
      <nav aria-label="Settings sections">
        <Stack gap="1">
          <NavItem
            as="button"
            type="button"
            active={active === "profile"}
            icon={<Icon icon={User} size="sm" />}
            onClick={() => select("profile")}
          >
            Profile
          </NavItem>
          <NavItem
            as="button"
            type="button"
            active={active === "appearance"}
            icon={<Icon icon={Palette} size="sm" />}
            onClick={() => select("appearance")}
          >
            Appearance
          </NavItem>
        </Stack>
      </nav>
    </Stack>
  );

  const detail =
    active === "profile" ? (
      <Panel padding="5">
        <Stack gap="4">
          <Stack gap="1">
            <Heading level={3}>Profile</Heading>
            <Text size="sm" color="text-muted">
              These apply to every agent you run.
            </Text>
          </Stack>
          <AccountSettingsForm />
        </Stack>
      </Panel>
    ) : (
      <Panel padding="5">
        <AppearanceSettingsSection />
      </Panel>
    );

  return (
    <AppLayout>
      <Page style={{ paddingBlock: "var(--space-6)" }}>
        <ResponsiveMasterDetail
          master={nav}
          detail={detail}
          showDetail={showDetail}
          onBack={() => setShowDetail(false)}
          backLabel="Settings"
          masterWidth="16rem"
        />
      </Page>
    </AppLayout>
  );
}
