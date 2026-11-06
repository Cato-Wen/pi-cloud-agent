"use client";

import type {
  RepositoryEnvironmentSummary,
  ReviewRepositoriesResponse,
  ReviewRepository,
  VcsRepository,
} from "@pi-cloud-agent/protocol";
import { LoaderCircleIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { InfoTooltip } from "./LlmConnectionSupport";

export function RepositorySettings() {
  const [data, setData] = useState<ReviewRepositoriesResponse | null>(null);
  const [repos, setRepos] = useState<VcsRepository[]>([]);
  const [images, setImages] = useState<RepositoryEnvironmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, environments, available] = await Promise.all([
        api.listReviewRepositories(),
        api.listRepositoryEnvironments(),
        api.listRepos(),
      ]);
      setData(next);
      setImages(environments);
      setRepos(available);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = [
    ...(data?.repositories.map((review) => ({
      provider: "github",
      repo: review.repo,
      review,
    })) ?? []),
    ...repos
      .filter(
        (repo) =>
          !data?.repositories.some(
            (item) => repo.provider === "github" && item.repo === repo.fullName,
          ),
      )
      .map((repo) => ({ provider: repo.provider, repo: repo.fullName, review: null })),
  ];
  return (
    <section>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-medium tracking-[-0.02em]">仓库</h2>
          <p className="mt-2 max-w-lg text-xs leading-5 text-muted-foreground">
            非草稿 PR 创建或更新时会自动评审；已有的 PR
            要等到下一次推送。评审使用你的默认模型。环境镜像是为仓库启动新会话时使用的公开
            Docker 镜像。
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.installUrl && (
            <a href={data.installUrl} className="text-xs underline underline-offset-4">
              管理 GitHub 访问权限
            </a>
          )}
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCwIcon className={loading ? "animate-spin" : ""} />
            刷新
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {data?.problem && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {data.problem}
        </p>
      )}
      {loading && !data && <p className="py-8 text-sm text-muted-foreground">正在加载仓库…</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          尚未连接任何仓库。请先通过上方的 GitHub 访问权限安装 App，再回到这里。
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem] gap-4 border-b border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground sm:grid">
            <span>仓库</span>
            <span className="flex items-center gap-1.5">
              环境镜像
              <InfoTooltip label="环境镜像要求">
                使用 Docker Hub 或 GHCR 上的公开 Docker
                镜像，并包含项目所需的工具。应用会自动加入 agent
                运行时，并在隔离沙箱中管理代码检出。
              </InfoTooltip>
            </span>
            <span className="text-right">自动评审</span>
          </div>
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <RepositoryRow
                key={`${row.provider}:${row.repo}`}
                {...row}
                image={
                  images.find(
                    (image) => image.provider === row.provider && image.repo === row.repo,
                  )?.imageRef ?? ""
                }
              />
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        环境镜像在离开输入框时自动保存，并对新会话生效。留空则使用默认镜像。
      </p>
    </section>
  );
}

function RepositoryRow({
  provider,
  repo,
  review,
  image,
}: {
  provider: string;
  repo: string;
  review: ReviewRepository | null;
  image: string;
}) {
  const [enabled, setEnabled] = useState(review?.autoReview ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEnabled(review?.autoReview ?? false);
  }, [review?.autoReview]);
  const toggle = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveReviewRepository({
        installationId: review.installationId,
        repo,
        autoReview: !enabled,
      });
      setEnabled(!enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const problem =
    review?.problem ??
    (provider === "github" && !review ? "在此仓库上安装 GitHub App 后即可启用评审。" : null);
  return (
    <li className="grid items-start gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem] sm:gap-4">
      <div className="min-w-0">
        <p className="break-all text-sm font-medium">{repo}</p>
        {problem && <p className="mt-1 text-xs leading-5 text-muted-foreground">{problem}</p>}
        {error && (
          <p role="alert" className="mt-1 break-words text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <EnvironmentEditor provider={provider} repo={repo} image={image} />
      <div className="flex items-center gap-2 sm:justify-end sm:pt-1">
        <span className="text-xs text-muted-foreground sm:hidden">自动评审</span>
        {provider === "github" ? (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`自动评审 ${repo}`}
            disabled={busy || !review || Boolean(problem && !enabled)}
            onClick={() => void toggle()}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40 ${enabled ? "bg-foreground" : "bg-input"}`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform ${enabled ? "left-0.5 translate-x-4" : "left-0.5"}`}
            />
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
    </li>
  );
}

function EnvironmentEditor({
  provider,
  repo,
  image,
}: {
  provider: string;
  repo: string;
  image: string;
}) {
  const [value, setValue] = useState(image);
  const [saved, setSaved] = useState(image);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValue(image);
    setSaved(image);
  }, [image]);
  const save = async () => {
    const next = value.trim();
    if (next === saved || busy) return;
    setBusy(true);
    setError(null);
    setMessage("保存中…");
    try {
      await api.saveRepositoryEnvironment({ provider, repo, imageRef: next });
      setSaved(next);
      setValue(next);
      setMessage("已保存");
    } catch (cause) {
      setMessage(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    const imageRef = value.trim();
    if (!imageRef || busy || testing) return;
    setTesting(true);
    setError(null);
    setMessage("测试中…");
    try {
      const result = await api.testRepositoryEnvironment({ provider, repo, imageRef });
      setMessage(result.ok ? "环境测试通过" : null);
      if (!result.ok) setError(result.output || "环境测试失败。");
    } catch (cause) {
      setMessage(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };
  return (
    <div>
      <div className="flex items-start gap-2">
        <input
          aria-label={`${repo} 的环境镜像`}
          placeholder="默认镜像"
          value={value}
          disabled={busy || testing}
          onChange={(event) => {
            setValue(event.target.value);
            setMessage(null);
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          spellCheck={false}
        />
        {value.trim() && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || testing}
            onClick={() => void test()}
            aria-label={`测试 ${repo} 的环境`}
          >
            {testing ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
            测试
          </Button>
        )}
      </div>
      {message && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 break-words text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
