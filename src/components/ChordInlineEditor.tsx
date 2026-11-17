import { useEffect, useRef } from 'react';

interface Props {
  /** Surface pixel position of the chord label (or of the note it will sit over). */
  x: number;
  y: number;
  bar: number;
  beat: number;
  value: string;
  valid: boolean;
  onChange: (value: string) => void;
  /** Commit; `move` steps to the next/previous chord change (Tab / ⇧Tab). */
  onCommit: (move?: 1 | -1) => void;
  onCancel: () => void;
}

/** A small text field drawn over the chord symbol on the paper. */
export default function ChordInlineEditor({
  x,
  y,
  bar,
  beat,
  value,
  valid,
  onChange,
  onCommit,
  onCancel,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [bar, beat]);
  return (
    <div
      className={`chord-inline ${valid ? '' : 'invalid'}`}
      style={{ left: Math.max(0, x - 6), top: Math.max(0, y - 6) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        ref={input}
        aria-label="和弦符号（就地编辑）"
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit();
          } else if (event.key === 'Tab') {
            event.preventDefault();
            onCommit(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={(event) => {
          // Clicking elsewhere commits, as in a notation editor; an invalid symbol is kept open.
          if (!event.currentTarget.closest('.chord-inline')?.contains(event.relatedTarget as Node | null)) {
            if (valid) onCommit();
          }
        }}
      />
      <small>
        第 {bar} 小节 · 第 {beat} 拍{valid ? '' : ' · 无法识别'}
      </small>
    </div>
  );
}
