"use client";

import type {
  CreateLlmConnectionRequest,
  LlmConnectionSummary,
} from "@pi-cloud-agent/protocol";
import { PlusIcon, TestTube2Icon } from "lucide-react";
import { useState } from "react";
import { CodexDeviceDialog } from "@/components/CodexDeviceDialog";
import { InfoTooltip, validateConnectionForm } from "@/components/LlmConnectionSupport";
import { LlmConnectionTable } from "@/components/LlmConnectionTable";
import { ModelSelect } from "@/components/ModelSelect";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { defaultModelSelection, parseModelSelection } from "@/lib/model-selection";

const ENDPOINT_OPTIONS = [
  {
    id: "openai-completions",
    label: "OpenAI 兼容 · Chat Completions",
    provider: "openai-compatible",
    api: "openai-completions",
  },
  {
    id: "openai-responses",
    label: "OpenAI 兼容 · Responses",
    provider: "openai-compatible",
    api: "openai-responses",
  },
  {
    id: "litellm",
    label: "LiteLLM 代理",
    provider: "litellm",
    api: "openai-completions",
  },
  {
    id: "anthropic",
    label: "Anthropic · Messages",
    provider: "anthropic",
    api: "anthropic-messages",
  },
] as const;

type EndpointId = (typeof ENDPOINT_OPTIONS)[number]["id"];

export function LlmConnectionSection({
  connections,
  onChanged,
  onNotice,
}: {
  connections: LlmConnectionSummary[];
  onChanged: () => Promise<void>;
  onNotice: (message: string, kind: "success" | "error") => void;
}) {
  const [open, setOpen] = useState(false);
  const [codexDialogOpen, setCodexDialogOpen] = useState(false);
  const [endpointId, setEndpointId] = useState<EndpointId>("openai-completions");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<CreateLlmConnectionRequest>({
    displayName: "",
    provider: "openai-compatible",
    api: "openai-completions",
    baseUrl: "",
    model: "",
    apiKey: "",
    contextWindow: 196_608,
    maxTokens: 32_000,
    // The server decides whether the first saved connection becomes default.
    // Do not derive this from the initial props: Settings loads connections
    // asynchronously, so that value would become stale for the lifetime of the
    // component and could replace an existing default on the next page load.
    isDefault: false,
  });

  const update = <K extends keyof CreateLlmConnectionRequest>(
    key: K,
    value: CreateLlmConnectionRequest[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const formError = validateConnectionForm(form);
  const formReady = formError === null;
  const reportError = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    onNotice(message, "error");
  };

  const selectEndpoint = (value: EndpointId) => {
    const endpoint = ENDPOINT_OPTIONS.find((option) => option.id === value);
    if (!endpoint) return;
    setEndpointId(value);
    setForm((current) => ({ ...current, provider: endpoint.provider, api: endpoint.api }));
  };

  const save = async () => {
    if (!formReady) return;
    setBusy("save");
    setError(null);
    try {
      await api.createLlmConnection(form);
      await onChanged();
      setOpen(false);
      setForm((current) => ({ ...current, apiKey: "", isDefault: false }));
      onNotice("模型连接已保存。", "success");
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!formReady) return;
    setBusy("test");
    setError(null);
    try {
      await api.testLlmConnection(form);
      onNotice("连接测试成功。", "success");
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.deleteLlmConnection(id);
      await onChanged();
      onNotice("模型连接已删除。", "success");
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const makeDefault = async (value: string) => {
    const selection = parseModelSelection(value);
    if (!selection) return;
    setBusy("default");
    setError(null);
    try {
      await api.setDefaultLlmConnection(selection.connectionId, selection.modelId);
      await onChanged();
      onNotice("默认模型已更新。", "success");
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {connections.length > 0 && (
        <>
          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-medium">默认模型</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              新任务默认使用此模型，每个任务仍可单独选择其他模型。
            </p>
            <ModelSelect
              connections={connections}
              value={defaultModelSelection(connections)}
              onChange={(value) => void makeDefault(value)}
              disabled={busy !== null}
              ariaLabel="默认模型"
              className="mt-3 w-full max-w-sm justify-between"
            />
          </section>
          <div className="pt-3">
            <h3 className="text-sm font-medium">连接</h3>
            <p className="mt-1 text-xs text-muted-foreground">任务可用的认证信息和模型列表。</p>
          </div>
          <LlmConnectionTable connections={connections} busyId={busy} onRemove={remove} />
        </>
      )}
      <section className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium">添加模型</h3>
        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          连接你的 AI 订阅，或自定义模型端点
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => setCodexDialogOpen(true)}
            disabled={busy !== null}
            variant="outline"
            size="sm"
          >
            连接 Codex
          </Button>
        </div>
        <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          或
          <span className="h-px flex-1 bg-border" />
        </div>
        {open ? (
          <div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs">
                <span>
                  名称 <RequiredMark />
                </span>
                <input
                  className="h-9 rounded-md border bg-background px-3"
                  value={form.displayName}
                  onChange={(e) => update("displayName", e.target.value)}
                  placeholder="我的模型网关"
                  required
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="flex items-center gap-1">
                  端点 <RequiredMark />
                </span>
                <select
                  className="h-9 rounded-md border bg-background px-3"
                  value={endpointId}
                  onChange={(e) => selectEndpoint(e.target.value as EndpointId)}
                  required
                >
                  {ENDPOINT_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-xs sm:col-span-2">
                <span>
                  Base URL <RequiredMark />
                </span>
                <input
                  className="h-9 rounded-md border bg-background px-3"
                  value={form.baseUrl}
                  onChange={(e) => update("baseUrl", e.target.value)}
                  placeholder="https://api.example.com/v1"
                  type="url"
                  required
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span>
                  模型 <RequiredMark />
                </span>
                <input
                  className="h-9 rounded-md border bg-background px-3"
                  value={form.model}
                  onChange={(e) => update("model", e.target.value)}
                  placeholder="模型名称"
                  required
                />
              </label>
              <label className="grid gap-1.5 text-xs sm:col-span-2">
                <span>
                  API key <RequiredMark />
                </span>
                <input
                  className="h-9 rounded-md border bg-background px-3"
                  value={form.apiKey}
                  onChange={(e) => update("apiKey", e.target.value)}
                  placeholder="提供方的 API key"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </label>
            </div>
            <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
              所有凭证均加密存储
              <InfoTooltip label="凭证处理说明">
                凭证加密存储，并且只传递给隔离的任务进程。
              </InfoTooltip>
            </p>
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" onClick={() => setOpen(false)} variant="outline" size="sm">
                取消
              </Button>
              <Button
                type="button"
                onClick={() => void test()}
                disabled={busy !== null || !formReady}
                variant="outline"
                size="sm"
              >
                <TestTube2Icon className="size-3.5" />
                {busy === "test" ? "测试中…" : "测试"}
              </Button>
              <InfoTooltip label="测试说明">
                使用此端点、API 格式、模型和 key 发送一个单 token
                请求。提供方可能会将其计入用量。
              </InfoTooltip>
              <Button
                type="button"
                onClick={() => void save()}
                disabled={busy !== null || !formReady}
                size="sm"
              >
                {busy === "save" ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            onClick={() => setOpen(true)}
            variant="outline"
            size="sm"
            className="border-dashed text-muted-foreground"
          >
            <PlusIcon className="size-3.5" /> 添加自定义模型
          </Button>
        )}
      </section>
      <CodexDeviceDialog
        open={codexDialogOpen}
        onClose={() => setCodexDialogOpen(false)}
        onConnected={onChanged}
        onNotice={onNotice}
      />
    </div>
  );
}

function RequiredMark() {
  return <span className="text-destructive">*</span>;
}
