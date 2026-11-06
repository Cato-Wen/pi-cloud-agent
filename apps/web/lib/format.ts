import { ACTIVE_STATUSES, type RunStatus } from "@pi-cloud-agent/protocol";

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "排队中",
  provisioning: "准备沙箱",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function isActiveStatus(status: RunStatus): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function formatDuration(seconds: number): string {
  const units = [
    { threshold: 86_400, divisor: 86_400, label: "天" },
    { threshold: 3_600, divisor: 3_600, label: "小时" },
    { threshold: 60, divisor: 60, label: "分钟" },
    { threshold: 0, divisor: 1, label: "秒" },
  ];
  const unit = units.find((candidate) => seconds >= candidate.threshold) ?? {
    threshold: 0,
    divisor: 1,
    label: "秒",
  };
  const value = Math.max(1, Math.round(seconds / unit.divisor));
  return `${value} ${unit.label}`;
}
