import { forwardRef, type HTMLAttributes, useState } from "react";
import styles from "./Avatar.module.css";
import { cx } from "./utils";

type AvatarSize = "sm" | "md" | "lg";

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** Display name - drives initials fallback and the accessible label. */
  name: string;
  /** Optional image URL. Falls back to initials if absent or fails to load. */
  src?: string;
  size?: AvatarSize;
}

/** Derive up to two uppercase initials from a display name. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministically pick one of the tinted hue classes from the name. */
function hueClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hues = [
    styles.hue0,
    styles.hue1,
    styles.hue2,
    styles.hue3,
    styles.hue4,
  ];
  return hues[Math.abs(hash) % hues.length];
}

/** Avatar - circular agent/user avatar showing an image or initials fallback. */
export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { name, src, size = "md", className, ...rest },
  ref,
) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <span
      ref={ref}
      role="img"
      aria-label={name}
      title={name}
      className={cx(
        styles.avatar,
        styles[size],
        !showImage && hueClass(name),
        className,
      )}
      {...rest}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          className={styles.image}
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true" className={styles.initials}>
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
});
