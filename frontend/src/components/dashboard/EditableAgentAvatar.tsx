import { Camera } from "lucide-react";
import { Avatar, FileButton, Icon } from "@/components/ui";
import styles from "./EditableAgentAvatar.module.css";

export interface EditableAgentAvatarProps {
  /** Agent display name - drives the initials fallback + accessible labels. */
  name: string;
  /** Current custom avatar (data URL); falls back to initials when absent. */
  src?: string;
  size?: "sm" | "md" | "lg";
  /** Called with the picked image File (parent resizes + persists). */
  onSelect: (file: File) => void;
}

/**
 * EditableAgentAvatar - an Avatar that doubles as an upload trigger: hovering (or
 * focusing) reveals a camera scrim, and clicking opens an image picker. Purely
 * presentational - the parent owns resizing + persistence via `onSelect`.
 */
export function EditableAgentAvatar({
  name,
  src,
  size = "md",
  onSelect,
}: EditableAgentAvatarProps) {
  return (
    <FileButton
      label={`Change avatar for ${name}`}
      accept="image/*"
      onSelect={onSelect}
      className={styles.trigger}
    >
      <Avatar name={name} src={src} size={size} />
      <span className={styles.overlay} aria-hidden="true">
        <Icon icon={Camera} size="sm" />
      </span>
    </FileButton>
  );
}
