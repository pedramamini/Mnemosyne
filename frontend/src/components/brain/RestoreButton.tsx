import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, Icon, Inline, Text } from "@/components/ui";

export interface RestoreButtonProps {
  /** Brain path the restore targets (shown in the confirm copy). */
  path: string;
  /** Full sha of the revision to restore to (the parent already has it). */
  sha: string;
  /** Short sha shown in the confirm copy. */
  shortSha: string;
  /** Fired once the user confirms. The parent owns the mutation + toasts. */
  onRestore: () => void;
  /** True while the parent's restore mutation is in flight. */
  isRestoring?: boolean;
}

/**
 * RestoreButton (MNEMO-39, PRD §6.9) - a one-click restore affordance guarded by
 * an explicit confirm dialog (restore overwrites the current file and lands a new
 * commit, so it must never be a single mis-click). Presentational + the confirm
 * flow only: the parent performs the actual `useRestoreFile` mutation in
 * `onRestore`. `sha` is unused in the copy but carried so the row's full context
 * lives on one component.
 */
export function RestoreButton({
  path,
  sha: _sha,
  shortSha,
  onRestore,
  isRestoring = false,
}: RestoreButtonProps) {
  const [open, setOpen] = useState(false);

  function confirm(): void {
    onRestore();
    setOpen(false);
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        loading={isRestoring}
        leftIcon={<Icon icon={RotateCcw} size="sm" />}
        onClick={() => setOpen(true)}
      >
        Restore
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Restore file?"
        footer={
          <Inline gap="2" justify="end" wrap={false}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={confirm} loading={isRestoring}>
              Confirm restore
            </Button>
          </Inline>
        }
      >
        <Text>
          Restore{" "}
          <Text as="span" weight="semibold">
            {path}
          </Text>{" "}
          to revision{" "}
          <Text as="span" weight="semibold">
            {shortSha}
          </Text>
          ? This overwrites the current file and creates a new commit.
        </Text>
      </Dialog>
    </>
  );
}
