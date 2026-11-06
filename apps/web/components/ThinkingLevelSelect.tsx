import type { ThinkingLevel } from "@pi-cloud-agent/protocol";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "思考：关",
  minimal: "思考：最低",
  low: "思考：低",
  medium: "思考：中",
  high: "思考：高",
  xhigh: "思考：极高",
  max: "思考：最高",
};

export function ThinkingLevelSelect({
  levels,
  value,
  onChange,
  disabled = false,
  className,
}: {
  levels: ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const level = levels.find((candidate) => candidate === next);
        if (level) onChange(level);
      }}
      disabled={disabled || levels.length < 2}
    >
      <SelectTrigger aria-label="思考级别" className={className}>
        <SelectValue>{LEVEL_LABELS[value] ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {LEVEL_LABELS[level] ?? level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
