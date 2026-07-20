"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import styles from "./Select.module.css";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string = string> {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Rendered beside the trigger and read out with it ("Auto, 30s"). */
  label?: string;
  /** For a select with no visible label. Ignored when `label` is given. */
  "aria-label"?: string;
  /** Opens right-aligned — for a trigger sitting near the right edge. */
  align?: "start" | "end";
  disabled?: boolean;
  className?: string;
}

/**
 * The app's dropdown: a trigger button plus a menu, not a native <select>.
 *
 * A native select cannot be styled past its border in any browser we care
 * about — the popup is the OS's, in the OS's colours and metrics — so one on a
 * dark surface reads as a piece of a different application. This is the same
 * construction as the chart-type menu (raised card, role="menu", the current
 * row aria-checked and tinted), so the two behave alike wherever they meet.
 *
 * That trade is only worth making if the replacement is as operable as the
 * control it replaces, which is why the keyboard handling below is not
 * optional: arrows move, Enter/Space pick, Escape returns focus to the trigger,
 * Tab leaves. A styled div that swallows the keyboard is a regression, however
 * good it looks.
 */
export function Select<T extends string = string>({
  options,
  value,
  onChange,
  label,
  "aria-label": ariaLabel,
  align = "start",
  disabled = false,
  className,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const labelId = useId();
  const triggerId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options.find((option) => option.value === value);

  /**
   * Which row the keyboard is on. Kept separate from `value` because moving
   * through the menu must not commit anything: a reader who arrows past three
   * options and hits Escape has changed nothing, exactly as with a native
   * select on every platform but Windows.
   */
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Opening lands on the current choice, so the first arrow press moves one
  // step from where the reader already is rather than from the top of the list.
  const openMenu = useCallback(
    (index: number) => {
      setActiveIndex(index);
      setOpen(true);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        // No focus return: the pointer has already moved the reader elsewhere,
        // and yanking focus back to the trigger would undo their click.
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Focus follows the active row while the menu is open, which is what makes
  // Enter/Space work without any key handling of our own — the focused item is
  // a real <button>, so the browser fires its click.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const pick = (next: T) => {
    onChange(next);
    close(true);
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    switch (ev.key) {
      case "Escape":
        if (!open) return;
        ev.preventDefault();
        close(true);
        return;
      case "Tab":
        // Not prevented: Tab means "leave", so let it leave — just don't leave
        // an orphaned menu floating over the page behind it.
        setOpen(false);
        return;
      case "ArrowDown":
        ev.preventDefault();
        if (!open) openMenu(selectedIndex);
        else setActiveIndex((i) => (i + 1) % options.length);
        return;
      case "ArrowUp":
        ev.preventDefault();
        if (!open) openMenu(selectedIndex);
        else setActiveIndex((i) => (i - 1 + options.length) % options.length);
        return;
      case "Home":
        if (!open) return;
        ev.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        if (!open) return;
        ev.preventDefault();
        setActiveIndex(options.length - 1);
        return;
      default:
        return;
    }
  };

  const menuLabel = label ?? ariaLabel;

  return (
    <div
      ref={rootRef}
      className={className ? `${styles.root} ${className}` : styles.root}
      onKeyDown={onKeyDown}
    >
      {label ? (
        <span className={styles.label} id={labelId}>
          {label}
        </span>
      ) : null}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        // With a visible label the trigger announces both halves — "Auto, 30s"
        // — the way a labelled native select does; `id` self-reference is how
        // the button's own text joins that sequence.
        {...(label
          ? { "aria-labelledby": `${labelId} ${triggerId}` }
          : { "aria-label": ariaLabel })}
        onClick={() => (open ? close(false) : openMenu(selectedIndex))}
      >
        {current?.label ?? ""}
        <ChevronDown
          className={styles.chevron}
          size={13}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div
          className={`${styles.menu} ${align === "end" ? styles.menuEnd : ""}`}
          role="menu"
          aria-label={menuLabel}
        >
          {options.map((option, index) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`${styles.item} ${active ? styles.itemActive : ""}`}
                // Roving tabindex: only the active row is tabbable, so Tab
                // leaves the whole menu instead of walking every option.
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => pick(option.value)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                {option.label}
                {active ? (
                  <Check
                    className={styles.check}
                    size={13}
                    strokeWidth={2.5}
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
