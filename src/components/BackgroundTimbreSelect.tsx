import type { BackgroundTimbre } from '../lib/auditionTimbre';

export default function BackgroundTimbreSelect({ value, onChange, disabled }: {
  value: BackgroundTimbre;
  onChange: (value: BackgroundTimbre) => void;
  disabled?: boolean;
}) {
  return <label className="background-timbre-control">
    <span>背景音色</span>{' '}
    <select aria-label="背景试听音色" value={value} disabled={disabled}
      onChange={e => onChange(e.target.value as BackgroundTimbre)}>
      <option value="piano">钢琴</option>
      <option value="original">原音色</option>
    </select>
  </label>;
}
