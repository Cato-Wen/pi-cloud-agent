"use client";

import { ClipboardCopyIcon, KeyRoundIcon, UsersIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PERSONAL_TOKEN_CHANGED } from "@/components/PersonalTokenCard";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export const GITHUB_INSTALLATION_CHANGED = "github-installation-changed";
const DISMISSED_KEY = "pca-access-onboarding-dismissed";

type State = { kind: "checking" } | { kind: "ready" } | { kind: "needed"; login: string };

/**
 * Shown on the new-task page until the user has some way to reach a
 * repository: a personal token (developers) or an agent / GitHub App
 * installation (product and QA). It never blocks the page — signing in is
 * enough to look around — and it goes away by itself once access exists.
 */
export function GithubOnboarding() {
  const pathname = usePathname();
  const [state, setState] = useState<State>({ kind: "checking" });
  const [dismissed, setDismissed] = useState(true);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await api.getCurrentUser();
      if (me.hasPat) {
        setState({ kind: "ready" });
        return;
      }
      const installed = await api
        .listReviewRepositories()
        .then((result) => result.repositories.some((repository) => repository.problem === null))
        .catch(() => false);
      setState(installed ? { kind: "ready" } : { kind: "needed", login: me.login });
    } catch {
      setState({ kind: "ready" });
    }
  }, []);

  useEffect(() => {
    setDismissed(window.sessionStorage.getItem(DISMISSED_KEY) === "1");
    void refresh();
    window.addEventListener(GITHUB_INSTALLATION_CHANGED, refresh);
    window.addEventListener(PERSONAL_TOKEN_CHANGED, refresh);
    return () => {
      window.removeEventListener(GITHUB_INSTALLATION_CHANGED, refresh);
      window.removeEventListener(PERSONAL_TOKEN_CHANGED, refresh);
    };
  }, [refresh]);

  if (state.kind !== "needed" || dismissed || pathname !== "/chat") return null;

  const requestMessage = `你好，请在 zen8agent 上给我分配一个 agent，我的 GitHub 登录名是 ${state.login}。`;

  return (
    <section
      aria-labelledby="access-onboarding-title"
      className="pointer-events-auto fixed inset-x-0 top-14 z-40 mx-auto w-[min(44rem,calc(100vw-2rem))] rounded-2xl border border-border bg-background/95 p-5 shadow-xl shadow-black/10 backdrop-blur md:left-[calc(var(--nav-width,252px)+1rem)] md:right-4 md:mx-0 md:w-auto"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="access-onboarding-title" className="text-base font-medium">
            {state.login}，你已登录。
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            你还没有任何仓库或 agent 的访问权限。请按你的角色选择下面一种方式。
          </p>
        </div>
        <button
          type="button"
          aria-label="暂时关闭"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            window.sessionStorage.setItem(DISMISSED_KEY, "1");
            setDismissed(true);
          }}
        >
          <XIcon className="size-4" />
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <KeyRoundIcon className="size-4" />
            我写代码
          </h3>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            添加 GitHub 个人访问 token。提交和 PR 会以你的身份创建。
          </p>
          <Link
            href="/settings"
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground transition-colors outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            去设置里添加 token
          </Link>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <UsersIcon className="size-4" />
            我是产品 / 测试
          </h3>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            由管理员给你分配一个团队 agent，它已经知道该使用哪些仓库。
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() =>
              void navigator.clipboard.writeText(requestMessage).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            <ClipboardCopyIcon className="size-3.5" />
            {copied ? "已复制" : "复制申请文案"}
          </Button>
        </div>
      </div>
    </section>
  );
}
