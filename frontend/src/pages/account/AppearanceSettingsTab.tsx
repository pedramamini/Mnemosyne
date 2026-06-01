import { useAppearance } from "@/appearance/AppearanceProvider";
import { FONTS, THEMES } from "@/appearance/appearance";
import {
  Badge,
  Code,
  Heading,
  Inline,
  Select,
  SettingRow,
  Stack,
  Text,
} from "@/components/ui";

/**
 * AppearanceSettingsSection - the color theme + typeface controls, rendered as a
 * section of labeled rows inside the single account-settings panel. Both are
 * token-only (`data-theme` / `data-font` on <html>) and persist on this device
 * via {@link useAppearance}; selecting one reskins the whole app live, so the
 * inline specimen updates in place. The command palette offers the same switches
 * as a shortcut.
 */
export function AppearanceSettingsSection() {
  const { theme, setTheme, font, setFont } = useAppearance();

  return (
    <Stack gap="4">
      <Stack gap="1">
        <Heading level={3}>Appearance</Heading>
        <Text size="sm" color="text-muted">
          Saved on this device and applied the moment you pick it.
        </Text>
      </Stack>

      <div>
        <SettingRow
          label="Theme"
          description="Color palette used across the app."
          htmlFor="settings-theme"
        >
          <Select
            id="settings-theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            options={THEMES.map((t) => ({ value: t.id, label: t.label }))}
          />
        </SettingRow>

        <SettingRow
          label="Typeface"
          description="Font used across the app."
          htmlFor="settings-font"
        >
          <Select
            id="settings-font"
            value={font}
            onChange={(e) => setFont(e.target.value)}
            options={FONTS.map((f) => ({ value: f.id, label: f.label }))}
          />
        </SettingRow>

        <SettingRow
          label="Preview"
          description="Live specimen in the current theme + typeface."
        >
          <Stack gap="2">
            <Heading level={4}>The quick brown fox</Heading>
            <Text>Jumps over the lazy dog - 0123456789.</Text>
            <Inline gap="2" align="center" wrap>
              <Badge variant="success">active</Badge>
              <Badge variant="warning">paused</Badge>
              <Code>brain.search("memory")</Code>
            </Inline>
          </Stack>
        </SettingRow>
      </div>
    </Stack>
  );
}
