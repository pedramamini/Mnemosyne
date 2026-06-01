import { useEffect, useState } from "react";
import {
  Button,
  FormField,
  Inline,
  Input,
  Modal,
  Stack,
  Textarea,
} from "@/components/ui";

export interface NewFileDialogProps {
  open: boolean;
  /** Directory the new file defaults into; prefills the path with `dir/`. */
  defaultDir: string;
  /** Called with a valid relative path + (optional) initial content. */
  onCreate: (path: string, content: string) => void;
  onClose: () => void;
}

/** Validate a new brain path: non-empty, relative, no `..`, names a file. */
function validatePath(raw: string): string | null {
  const path = raw.trim();
  if (!path) return "Enter a file path.";
  if (path.startsWith("/")) return "Path must be relative (no leading “/”).";
  if (path.includes("\\")) return "Use “/” to separate folders, not “\\”.";
  if (path.split("/").some((seg) => seg === ".."))
    return "Path must not contain “..” segments.";
  if (path.endsWith("/")) return "Path must include a file name.";
  return null;
}

/** Seed the path field from a default directory (prefilled with a trailing slash). */
function seedPath(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * NewFileDialog (MNEMO-38) - a modal that collects a new file path (prefilled
 * with the parent dir) and optional initial content, validates the path is a
 * safe relative file path, and calls `onCreate`. Presentational + local form
 * state only; the parent owns the write.
 */
export function NewFileDialog({
  open,
  defaultDir,
  onCreate,
  onClose,
}: NewFileDialogProps) {
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset the form each time the dialog (re)opens for a given directory.
  useEffect(() => {
    if (open) {
      setPath(seedPath(defaultDir));
      setContent("");
      setError(null);
    }
  }, [open, defaultDir]);

  function handleCreate(): void {
    const message = validatePath(path);
    if (message) {
      setError(message);
      return;
    }
    onCreate(path.trim(), content);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New file"
      footer={
        <Inline gap="2" justify="end" wrap={false}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleCreate}>
            Create file
          </Button>
        </Inline>
      }
    >
      <Stack gap="4">
        <FormField
          label="Path"
          help="Relative to the brain root, e.g. notes/idea.md or tools/scrape.py"
          error={error ?? undefined}
        >
          <Input
            value={path}
            placeholder="notes/idea.md"
            onChange={(e) => {
              setPath(e.target.value);
              if (error) setError(null);
            }}
          />
        </FormField>
        <FormField
          label="Initial content"
          help="Optional - leave blank to start empty."
        >
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            spellCheck={false}
          />
        </FormField>
      </Stack>
    </Modal>
  );
}
