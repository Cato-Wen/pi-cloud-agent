"use client";

import type { PullRequestReview, PullRequestReviewsResponse } from "@pi-cloud-agent/protocol";
import { GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const LABELS: Record<PullRequestReview["status"], string> = {
  not_reviewed: "未评审",
  skipped: "已跳过",
  received: "已接收",
  queued: "排队中",
  starting: "启动中",
  reviewing: "评审中",
  publishing: "发布中",
  reviewed: "已评审",
  outdated: "已过期",
  failed: "失败",
  cancelled: "已取消",
};

export default function ReviewsPage() {
  const [data, setData] = useState<PullRequestReviewsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await api.listReviews();
      if (current === generation.current) {
        setData(next);
        setError(null);
      }
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="app-header flex h-12 shrink-0 items-center justify-between px-5">
        <h1 className="text-[13px] font-medium">评审</h1>
        <Link
          href="/settings?tab=repositories"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          仓库设置
        </Link>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-8 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-medium tracking-[-0.02em]">开放中的 PR</h2>
              <p className="mt-2 text-xs text-muted-foreground">
                来自已连接仓库的 PR，包括尚未评审的。
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className={loading ? "animate-spin" : ""} />
              {loading ? "刷新中…" : "刷新"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {error} {data && "当前显示的是上一次的结果。"}
            </p>
          )}
          {data?.problems.map((problem) => (
            <p key={problem} role="alert" className="mb-3 text-sm text-destructive">
              {problem}
            </p>
          ))}
          {!data && loading && (
            <p role="status" className="py-10 text-center text-sm text-muted-foreground">
              正在从 GitHub 加载 PR…
            </p>
          )}
          {data && data.pullRequests.length === 0 && (
            <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
              <GitPullRequestIcon className="mx-auto mb-3 size-5 text-muted-foreground" />
              <p className="text-sm">
                {data.problems.length ? "PR 未能完整加载。" : "暂无开放中的 PR。"}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                在仓库设置中开启自动评审，然后创建一个非草稿 PR 或推送新的提交。
              </p>
            </div>
          )}
          {Boolean(data?.pullRequests.length) && (
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_6rem] gap-6 border-b border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground sm:grid">
                <span>PR</span>
                <span>评审状态</span>
                <span className="text-right">会话</span>
              </div>
              <ul className="divide-y divide-border">
                {data?.pullRequests.map((pr) => (
                  <ReviewRow key={`${pr.repo}:${pr.number}`} pr={pr} />
                ))}
              </ul>
            </div>
          )}
          {data && (
            <p className="mt-4 text-xs text-muted-foreground">
              上次获取时间：
              {new Date(data.fetchedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
              。点击刷新查看更新。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewRow({ pr }: { pr: PullRequestReview }) {
  const color =
    pr.status === "failed"
      ? "text-destructive"
      : pr.status === "reviewed"
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-foreground";
  return (
    <li className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_6rem] sm:gap-6">
      <div className="min-w-0">
        <a
          href={`https://github.com/${pr.repo}/pull/${pr.number}`}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium hover:underline"
        >
          {pr.title}
        </a>
        <p className="mt-1.5 break-all text-xs text-muted-foreground">
          {pr.repo} #{pr.number} <span className="mx-1">·</span> {pr.headSha.slice(0, 7)}
        </p>
      </div>
      <div className="min-w-0">
        {pr.reviewUrl ? (
          <a
            href={pr.reviewUrl}
            target="_blank"
            rel="noreferrer"
            className={`text-xs font-medium hover:underline ${color}`}
          >
            {LABELS[pr.status]}
          </a>
        ) : (
          <span className={`text-xs font-medium ${color}`}>{LABELS[pr.status]}</span>
        )}
        <p className="mt-1 text-xs leading-5 text-muted-foreground break-words">{pr.detail}</p>
      </div>
      <div className="sm:text-right">
        {pr.sessionId ? (
          <Link
            href={`/sessions/${pr.sessionId}`}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            查看会话
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
    </li>
  );
}
