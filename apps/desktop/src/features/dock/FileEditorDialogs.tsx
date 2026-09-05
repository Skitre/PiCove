import { Dialog } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import { answerFileLeave, useFileSession } from "./file-session";

export function FileEditorDialogs() {
  const t = useT();
  const { leavePrompt, path, saving } = useFileSession();
  if (!leavePrompt) return null;
  return (
    <Dialog
      title={t("fileUnsavedTitle")}
      confirmLabel={saving ? t("fileSaving") : t("fileSave")}
      onConfirm={() => void answerFileLeave("save")}
      onCancel={() => void answerFileLeave("cancel")}
    >
      <p className="break-all">{path}</p>
      <button
        type="button"
        disabled={saving}
        className="mt-4 rounded border border-border px-3 py-1.5 text-danger disabled:opacity-40"
        onClick={() => void answerFileLeave("discard")}
      >
        {t("fileDiscard")}
      </button>
    </Dialog>
  );
}
