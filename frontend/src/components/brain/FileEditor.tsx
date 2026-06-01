import { FileText, History } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button,
  EmptyState,
  Heading,
  Icon,
  Inline,
  Spinner,
  Stack,
  Textarea,
} from "@/components/ui";

export interface FileEditorProps {
  /** Brain-relative path of the open file, or `null` for the empty state. */
  path: string | null;
  /** The loaded file contents (the editor's clean baseline). */
  content: string;
  /** True while the file is loading; the editor shows a spinner instead. */
  isLoading?: boolean;
  /** True while a save is in flight; disables Save and shows its spinner. */
  isSaving?: boolean;
  /** Persist the edited contents. */
  onSave: (newContent: string) => void;
  /** Discard edits / close the editor. */
  onCancel: () => void;
  /** When set, shows a "View history" affordance that opens this file's history (MNEMO-39). */
  onViewHistory?: () => void;
}

/**
 * FileEditor (MNEMO-38) - a view/edit panel for a single brain file. Tracks a
 * local dirty buffer seeded from `content`; Save is enabled only once the buffer
 * differs from the loaded content (and never while saving). Presentational - the
 * parent owns the write mutation.
 */
export function FileEditor({
  path,
  content,
  isLoading = false,
  isSaving = false,
  onSave,
  onCancel,
  onViewHistory,
}: FileEditorProps) {
  const [value, setValue] = useState(content);

  // Reseed the buffer whenever a different file (or fresh content) loads, so the
  // dirty check resets and an external save/refresh isn't reported as an edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `path` is intentional - switching to a different file with identical content must still reseed the buffer.
  useEffect(() => {
    setValue(content);
  }, [content, path]);

  if (!path) {
    return (
      <EmptyState
        icon={<Icon icon={FileText} size="lg" />}
        title="Select a file to view"
        description="Choose a file from the brain tree to view or edit its contents."
      />
    );
  }

  const dirty = value !== content;

  return (
    <Stack gap="3">
      <Inline gap="3" justify="between" align="center" wrap={false}>
        <Heading level={4}>{path}</Heading>
        <Inline gap="2" wrap={false}>
          {onViewHistory && (
            <Button
              variant="ghost"
              onClick={onViewHistory}
              disabled={isSaving}
              leftIcon={<Icon icon={History} size="sm" />}
            >
              View history
            </Button>
          )}
          <Button variant="ghost" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onSave(value)}
            loading={isSaving}
            disabled={!dirty || isSaving}
          >
            Save
          </Button>
        </Inline>
      </Inline>
      {isLoading ? (
        <Spinner label="Loading file" />
      ) : (
        <Textarea
          aria-label={`Contents of ${path}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={20}
          spellCheck={false}
        />
      )}
    </Stack>
  );
}
