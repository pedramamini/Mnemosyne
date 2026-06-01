import { forwardRef, type HTMLAttributes } from "react";
import styles from "./Code.module.css";
import { cx } from "./utils";

export interface CodeProps extends HTMLAttributes<HTMLElement> {
  /** Render as a multi-line `<pre><code>` block instead of inline. */
  block?: boolean;
}

/** Code - inline (or block) monospace code, token-styled. */
export const Code = forwardRef<HTMLElement, CodeProps>(function Code(
  { block, className, children, ...rest },
  ref,
) {
  if (block) {
    return (
      <pre className={cx(styles.pre, className)}>
        <code ref={ref} className={styles.code} {...rest}>
          {children}
        </code>
      </pre>
    );
  }
  return (
    <code
      ref={ref}
      className={cx(styles.code, styles.inline, className)}
      {...rest}
    >
      {children}
    </code>
  );
});

export type KbdProps = HTMLAttributes<HTMLElement>;

/** Kbd - a keyboard-key glyph, token-styled. */
export const Kbd = forwardRef<HTMLElement, KbdProps>(function Kbd(
  { className, children, ...rest },
  ref,
) {
  return (
    <kbd ref={ref} className={cx(styles.kbd, className)} {...rest}>
      {children}
    </kbd>
  );
});
