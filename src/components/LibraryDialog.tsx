import { useEffect, useState } from 'react';
import { ArrowRight, MusicNotes, Trash } from '@phosphor-icons/react';
import Modal from './Modal';
import LocalResults from './LocalResults';
import {
  archiveWorkspace,
  deleteLibraryEntry,
  readLibrary,
  workspaceFingerprint,
  type LibraryEntry,
} from '../lib/library';
import type { WorkspaceState } from '../lib/storage';
import type { ScoreProject } from '../lib/types';

export default function LibraryDialog({
  workspace,
  onClose,
  onOpen,
  onImport,
  onNew,
  onDemo,
  onExport,
  onChooseImport,
}: {
  workspace: WorkspaceState;
  onClose: () => void;
  onOpen: (workspace: WorkspaceState) => Promise<boolean>;
  onImport: (project: ScoreProject) => Promise<boolean>;
  onNew: () => void;
  onDemo: () => void;
  onExport: () => void;
  onChooseImport: () => void;
}) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [filter, setFilter] = useState<'recent' | 'all' | 'versions'>('recent');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [deleting, setDeleting] = useState<string>();
  const [exportState, setExportState] = useState('尚未生成便携包');
  const reload = async () => {
    const next = await readLibrary();
    setEntries(next);
    const receipt = next.find((entry) => entry.id === `project:${workspace.source.id}`)?.exportReceipt;
    setExportState(
      receipt
        ? `${receipt.fingerprint === (await workspaceFingerprint(workspace)) ? '当前版本已生成便携包' : '上次生成便携包后有修改'} · ${new Date(receipt.createdAt).toLocaleString('zh-CN')}`
        : '尚未生成便携包',
    );
  };
  useEffect(() => {
    void reload()
      .catch((cause) => setError(String(cause.message ?? cause)))
      .finally(() => setBusy(false));
  }, []);
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工程库操作失败。');
    } finally {
      setBusy(false);
    }
  };
  const projects = entries.filter(
    (entry) => entry.kind === 'project' && entry.workspace.source.id !== workspace.source.id,
  );
  const shown =
    filter === 'versions'
      ? entries.filter((entry) => entry.kind === 'version')
      : filter === 'recent'
        ? projects.slice(0, 12)
        : projects;
  return (
    <Modal
      title="工程库"
      eyebrow="YOUR LIBRARY"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="library-item current-project">
        <MusicNotes size={24} />
        <div>
          <strong>{workspace.source.title}</strong>
          <span>当前工程 · {exportState}</span>
        </div>
        <button className="secondary-button" onClick={onExport} disabled={busy}>
          导出备份
        </button>
      </div>
      <p className="subtle-note">
        工程保存在此浏览器，不再按数量淘汰。清除网站数据仍会删除本机记录；便携包生成后请确认下载文件已保留。
      </p>
      <form
        className="library-version-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim())
            void act(async () => {
              await archiveWorkspace({ ...workspace, savedAt: new Date().toISOString() }, name.trim());
              setName('');
              setFilter('versions');
            });
        }}
      >
        <input
          aria-label="版本名称"
          placeholder="例如：周六排练前"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        <button className="secondary-button" disabled={busy || !name.trim()}>
          保存命名版本
        </button>
      </form>
      <div className="library-filters" role="group" aria-label="工程库范围">
        {(['recent', 'all', 'versions'] as const).map((value) => (
          <button
            key={value}
            className="secondary-button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === 'recent'
              ? '最近打开'
              : value === 'all'
                ? `全部工程（${projects.length + 1}）`
                : '命名版本'}
          </button>
        ))}
      </div>
      {busy && <p role="status">正在保存或读取工程…</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="library-list library-scroll">
        {!busy && !shown.length && (
          <p className="subtle-note">
            {filter === 'versions' ? '还没有命名版本。' : '其他工程会显示在这里。'}
          </p>
        )}
        {shown.map((entry) => (
          <div key={entry.id} className="library-record">
            <button
              className="library-item"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const next = structuredClone(entry.workspace);
                  if (entry.kind === 'version') {
                    next.source.id = crypto.randomUUID();
                    next.source.title += ` · ${entry.name}`;
                    if (next.arrangement) next.arrangement.id = crypto.randomUUID();
                  }
                  await onOpen(next);
                })
              }
            >
              <MusicNotes size={22} />
              <div>
                <strong>{entry.name ?? entry.workspace.source.title}</strong>
                <span>
                  {entry.kind === 'version' ? `${entry.workspace.source.title} · 打开为副本 · ` : ''}
                  {new Date(entry.workspace.savedAt).toLocaleString('zh-CN')}
                </span>
              </div>
              <ArrowRight size={17} />
            </button>
            <button
              className="icon-button"
              aria-label={`删除${entry.name ?? entry.workspace.source.title}`}
              disabled={busy}
              onClick={() => setDeleting(entry.id)}
            >
              <Trash size={18} />
            </button>
            {deleting === entry.id && (
              <div className="library-delete-confirm">
                <span>删除这条保存记录？音频素材保留。</span>
                <button className="secondary-button" onClick={() => setDeleting(undefined)}>
                  保留
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await deleteLibraryEntry(entry.id);
                      setDeleting(undefined);
                    })
                  }
                >
                  确认删除
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <LocalResults currentId={workspace.source.id} onOpen={onImport} />
      <div className="modal-actions">
        <button className="secondary-button" onClick={onNew} disabled={busy}>
          新建空白谱
        </button>
        <button className="secondary-button" onClick={onDemo} disabled={busy}>
          打开原创示例
        </button>
        <button className="primary-button" onClick={onChooseImport} disabled={busy}>
          导入音乐
        </button>
      </div>
    </Modal>
  );
}
