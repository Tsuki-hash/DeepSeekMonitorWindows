import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../error-state";
import { updateTime } from "../data-display";

type Diagnostics = {
  version: string;
  platform: string;
  apiKeyConfigured: boolean;
  usageTokenConfigured: boolean;
  autoRefreshEnabled: boolean;
  refreshIntervalSeconds: number;
};
type ReleaseCheck = {
  currentVersion: string;
  latestVersion: string | null;
  state: "available" | "current" | "ahead" | "unavailable";
  checkedAt: number;
};

export function SupportSettings() {
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [diagnostics, setDiagnostics] = React.useState("");
  const [release, setRelease] = React.useState<ReleaseCheck | null>(null);
  const [releaseError, setReleaseError] = React.useState(false);
  const checkRelease = async () => {
    setBusy(true);
    setStatus("");
    setReleaseError(false);
    try {
      setRelease(await invoke<ReleaseCheck>("check_app_release"));
    } catch (error) {
      setReleaseError(true);
      setStatus(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const openPage = async (page: "releases" | "issues") => {
    setBusy(true);
    setStatus("");
    try {
      await invoke("open_support_page", { page });
      setStatus("已在浏览器打开");
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const loadDiagnostics = async () => {
    setBusy(true);
    setStatus("");
    try {
      const info = await invoke<Diagnostics>("get_diagnostics");
      setDiagnostics(
        [
          `版本：${info.version}`,
          `系统：${info.platform}`,
          `API Key：${info.apiKeyConfigured ? "已配置" : "未配置"}`,
          `用量 Token：${info.usageTokenConfigured ? "已配置" : "未配置"}`,
          `自动刷新：${info.autoRefreshEnabled ? "开启" : "关闭"}`,
          `刷新间隔：${info.refreshIntervalSeconds} 秒`,
        ].join("\n"),
      );
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics);
      setStatus("诊断信息已复制");
    } catch {
      setStatus("复制失败，可选中下方文字手动复制");
    }
  };
  return (
    <details className="settings-disclosure">
      <summary>帮助与诊断</summary>
      <div className="disclosure-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void checkRelease()}
        >
          检查更新
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void openPage("issues")}
        >
          反馈问题
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void loadDiagnostics()}
        >
          查看诊断
        </button>
        {diagnostics && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void copyDiagnostics()}
          >
            复制诊断
          </button>
        )}
      </div>
      {release && (
        <p className="muted" role="status">
          {release.state === "available"
            ? `发现新版本 v${release.latestVersion}`
            : release.state === "current"
              ? "当前已是最新发行版"
              : release.state === "ahead"
                ? `当前为开发版本，最新发行版为 v${release.latestVersion}`
                : "暂未取得公开发行版本"}{" "}
          · 检查于 {updateTime(release.checkedAt)}
          {releaseError && "（上次结果）"}
        </p>
      )}
      <div className="disclosure-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void openPage("releases")}
        >
          查看发行页面
        </button>
      </div>
      {diagnostics && (
        <textarea
          className="diagnostics-text"
          aria-label="脱敏诊断信息"
          readOnly
          value={diagnostics}
          rows={6}
        />
      )}
      <p className="muted">诊断不含密钥与路径，仅在本地展示，不自动上传。</p>
      {status && (
        <p className="muted" role="status">
          {status}
        </p>
      )}
    </details>
  );
}
