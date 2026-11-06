"use client";

import type {
  LlmConnectionSummary,
  ReposResponse,
  ThinkingLevel,
} from "@pi-cloud-agent/protocol";

type PickerRepo = ReposResponse["repos"][number];

import { FolderGit2Icon, GitBranchIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ChatComposer } from "@/components/ChatComposer";
import { ModelSelect } from "@/components/ModelSelect";
import { ThinkingLevelSelect } from "@/components/ThinkingLevelSelect";
import { SearchSelect } from "@/components/ui/search-select";
import { api } from "@/lib/api";
import {
  defaultModelSelection,
  parseModelSelection,
  preferredThinkingLevel,
  selectedModel,
} from "@/lib/model-selection";
import { saveSessionTitle } from "@/lib/session-titles";

export default function ChatPage() {
  return (
    <Suspense>
      <NewSession />
    </Suspense>
  );
}

function NewSession() {
  const router = useRouter();
  const params = useSearchParams();
  const [repos, setRepos] = useState<PickerRepo[]>([]);
  const [modelConnections, setModelConnections] = useState<LlmConnectionSummary[]>([]);
  const [repo, setRepo] = useState(params.get("repo") ?? "");
  const [provider, setProvider] = useState("github");
  const [modelSelection, setModelSelection] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const [prompt, setPrompt] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listRepos(), api.listLlmConnections()])
      .then(([loadedRepos, loadedConnections]) => {
        if (!alive) return;
        setRepos(loadedRepos);
        setModelConnections(loadedConnections);
        const selection = defaultModelSelection(loadedConnections);
        setModelSelection(selection);
        setThinkingLevel(preferredThinkingLevel(selectedModel(loadedConnections, selection)));
        const selected = loadedRepos[0];
        if (selected) {
          setRepo((current) => current || selected.fullName);
          setProvider(selected.provider);
        }
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!repo || !provider) {
      setBranches([]);
      setBranch("");
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    api
      .listBranches(provider, repo)
      .then((result) => {
        if (!cancelled) {
          setBranches(result.branches);
          setBranch(result.default ?? result.branches[0] ?? "");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBranches([]);
          setBranch("");
        }
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, repo]);

  const canSubmit =
    Boolean(repo) && Boolean(prompt.trim()) && !submitting && Boolean(modelSelection);
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const selection = parseModelSelection(modelSelection);
      if (!selection) throw new Error("开始任务前请先选择模型");
      const session = await api.createSession({
        repo,
        provider,
        prompt: prompt.trim(),
        branch: branch || null,
        modelConnectionId: selection.connectionId,
        modelId: selection.modelId,
        thinkingLevel,
      });
      saveSessionTitle(session.id, prompt.trim());
      router.push(`/sessions/${session.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="app-header flex h-12 shrink-0 items-center px-4">
        <h1 className="text-[13px] font-medium">新建任务</h1>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-10 sm:px-8">
        <div className="w-full max-w-2xl">
          <div className="mb-6 text-center">
            <h2 className="text-xl font-medium tracking-[-0.02em]">今天要做什么？</h2>
          </div>
          <ChatComposer
            value={prompt}
            onChange={setPrompt}
            onSubmit={submit}
            placeholder="描述要让 Pi 完成的任务…"
            submitLabel="开始"
            submitEnabled={canSubmit}
            submitting={submitting}
            disabled={!repo}
            autoFocus
            tools={
              <ComposerOptions
                repo={repo}
                repos={repos}
                onRepoChange={(selected) => {
                  setRepo(selected.fullName);
                  setProvider(selected.provider);
                }}
                onManualRepoChange={(value) => {
                  setRepo(value);
                  setProvider("github");
                }}
                modelSelection={modelSelection}
                modelConnections={modelConnections}
                onModelSelectionChange={setModelSelection}
                thinkingLevel={thinkingLevel}
                onThinkingLevelChange={setThinkingLevel}
                branch={branch}
                branches={branches}
                branchesLoading={branchesLoading}
                onBranchChange={setBranch}
              />
            }
          />
          <p className="mt-3 px-2 text-center text-xs text-muted-foreground">
            {modelConnections.length === 0 ? (
              <>
                开始任务前，请先在
                <Link href="/settings" className="underline underline-offset-2">
                  设置
                </Link>
                中添加模型连接。
              </>
            ) : repos.length === 0 ? (
              <>
                请先在
                <Link href="/settings" className="underline underline-offset-2">
                  设置
                </Link>
                中连接 VCS 身份，再选择仓库。
              </>
            ) : (
              "选择仓库，然后描述要让 agent 完成的任务。"
            )}
          </p>
          {error && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type ComposerOptionsProps = {
  repo: string;
  repos: PickerRepo[];
  onRepoChange: (value: PickerRepo) => void;
  onManualRepoChange: (value: string) => void;
  modelSelection: string;
  modelConnections: LlmConnectionSummary[];
  onModelSelectionChange: (value: string) => void;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (value: ThinkingLevel) => void;
  branch: string;
  branches: string[];
  branchesLoading: boolean;
  onBranchChange: (value: string) => void;
};

function ComposerOptions(props: ComposerOptionsProps) {
  const triggerClass =
    "h-7 min-w-0 max-w-36 shrink border-0 bg-transparent px-1.5 text-xs shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent";
  const model = selectedModel(props.modelConnections, props.modelSelection);
  return (
    <>
      <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {props.repos.length === 0 ? (
        <input
          aria-label="仓库"
          className="h-7 w-32 min-w-0 border-0 bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground"
          placeholder="owner/repo"
          value={props.repo}
          onChange={(event) => props.onManualRepoChange(event.target.value)}
        />
      ) : (
        <SearchSelect
          ariaLabel="仓库"
          className="max-w-48"
          placeholder="仓库"
          searchPlaceholder="搜索仓库，例如 master-data"
          emptyText="没有匹配的仓库"
          options={props.repos.map((entry) => ({
            value: entry.fullName,
            hint:
              entry.access === "write" ? "可写" : entry.access === "read" ? "只读" : undefined,
          }))}
          value={props.repo}
          allowCustom
          onChange={(value) => {
            const selected = props.repos.find((entry) => entry.fullName === value);
            if (selected) props.onRepoChange(selected);
            else props.onManualRepoChange(value);
          }}
        />
      )}
      <GitBranchIcon className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
      <SearchSelect
        ariaLabel="分支"
        className="max-w-36"
        placeholder={props.branchesLoading ? "加载中…" : "分支"}
        searchPlaceholder="搜索分支"
        emptyText="没有匹配的分支"
        options={props.branches.map((name) => ({ value: name }))}
        value={props.branch}
        allowCustom
        onChange={(value) => props.onBranchChange(value)}
        disabled={props.branchesLoading}
      />
      <ModelSelect
        connections={props.modelConnections}
        value={props.modelSelection}
        onChange={(value) => {
          props.onModelSelectionChange(value);
          props.onThinkingLevelChange(
            preferredThinkingLevel(
              selectedModel(props.modelConnections, value),
              props.thinkingLevel,
            ),
          );
        }}
        className={triggerClass}
      />
      <ThinkingLevelSelect
        levels={model?.thinkingLevels ?? ["off"]}
        value={props.thinkingLevel}
        onChange={props.onThinkingLevelChange}
        className={triggerClass}
      />
    </>
  );
}
