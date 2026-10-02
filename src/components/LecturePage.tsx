"use client";

/**
 * LECTURE：授業の文字起こしと、まとめ（全体像・重要なところ）の PDF。
 *   録音を始める → その場で文字になる → 「まとめる」で Gemini が整理 → 「PDF で保存」
 * 文字起こし・まとめは、このブラウザの中に保存し、まとめたら脳（Obsidian）の「授業」フォルダにも保存する（音声は保存しない）。
 * 録音中にほかの画面へ移っても、録音は続ける。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  clock,
  deleteLecture,
  LectureRecorder,
  loadLectures,
  saveLecture,
  supportsLectureRecording,
  transcriptText,
  type Lecture,
  type LectureSummary,
} from "@/lib/lecture";
import { Icon } from "./icons";
import { Card, Empty, Page, type Msg } from "./Pages";

type RecState = "idle" | "recording" | "paused";

const newLecture = (subject: string): Lecture => ({
  id: `lec-${Date.now().toString(36)}`,
  subject,
  startedAt: new Date().toISOString(),
  duration: 0,
  segments: [],
});

export const LecturePage = memo(function LecturePage({
  hidden,
  onRecording,
}: {
  hidden: boolean;
  /** 録音を始めた・止めた（音声会話のマイクと取り合わないよう、画面全体に知らせる） */
  onRecording?: (on: boolean) => void;
}) {
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [current, setCurrent] = useState<Lecture | null>(null);
  const [subject, setSubject] = useState("");
  const [rec, setRec] = useState<RecState>("idle");
  const [interim, setInterim] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<Msg>();
  const [busy, setBusy] = useState<"summary" | "pdf" | "brain" | null>(null);
  const [withTranscript, setWithTranscript] = useState(true);
  const [supported, setSupported] = useState(true);
  const recorder = useRef<LectureRecorder | null>(null);
  const currentRef = useRef<Lecture | null>(null);
  currentRef.current = current;
  const textRef = useRef<HTMLDivElement>(null);
  const onRecordingRef = useRef(onRecording);
  onRecordingRef.current = onRecording;

  useEffect(() => {
    setLectures(loadLectures());
    setSupported(supportsLectureRecording());
  }, []);

  /** 今の授業を保存して、一覧も新しくする */
  const persist = useCallback((lecture: Lecture) => {
    if (!saveLecture(lecture)) setMessage({ ok: false, text: "ブラウザの保存容量が足りず、保存できませんでした。古い授業を消してください。" });
    setLectures(loadLectures());
  }, []);

  // 変わったら 2 秒以内に保存する（録音中も数秒ごとに保存されるので、再読み込み・電池切れでも消えない）
  const saveTimer = useRef(0);
  const update = useCallback(
    (fn: (l: Lecture) => Lecture) => {
      setCurrent((prev) => (prev ? fn(prev) : prev));
      if (saveTimer.current) return;
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = 0;
        if (currentRef.current) persist(currentRef.current);
      }, 2000);
    },
    [persist],
  );

  const getRecorder = useCallback(() => {
    recorder.current ??= new LectureRecorder({
      final: (seg) => update((l) => ({ ...l, segments: [...l.segments, seg], duration: Math.max(l.duration, seg.t) })),
      interim: setInterim,
      error: (text) => {
        setMessage({ ok: false, text });
        if (!recorder.current?.recording) {
          setRec((r) => (r === "recording" ? "paused" : r));
          onRecordingRef.current?.(false);
        }
      },
    });
    return recorder.current;
  }, [update]);

  // 録音中は時間を進める
  useEffect(() => {
    if (rec !== "recording") return;
    const id = window.setInterval(() => {
      const t = recorder.current?.elapsed() ?? 0;
      setElapsed(t);
      update((l) => ({ ...l, duration: t }));
    }, 1000);
    return () => clearInterval(id);
  }, [rec, update]);

  // 新しい文が出たら、いちばん下まで送る
  useEffect(() => {
    const el = textRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [current?.segments.length, interim]);

  // 画面を閉じるときは止めて保存
  useEffect(
    () => () => {
      recorder.current?.pause();
      if (currentRef.current) saveLecture(currentRef.current);
    },
    [],
  );

  const start = () => {
    setMessage(undefined);
    let lecture = current;
    if (!lecture) {
      lecture = newLecture(subject.trim());
      setCurrent(lecture);
      persist(lecture);
    }
    if (getRecorder().start(lecture.duration)) {
      setRec("recording");
      onRecording?.(true);
    }
  };

  const pause = () => {
    recorder.current?.pause();
    setRec("paused");
    onRecording?.(false);
    setInterim("");
    if (currentRef.current) persist({ ...currentRef.current, duration: recorder.current?.elapsed() ?? currentRef.current.duration });
  };

  /** 今の授業を閉じて、新しい授業の準備 */
  const finish = () => {
    if (rec === "recording") pause();
    if (currentRef.current) persist(currentRef.current);
    recorder.current = null;
    setCurrent(null);
    setRec("idle");
    setElapsed(0);
    setSubject("");
  };

  const open = (l: Lecture) => {
    if (rec === "recording") pause();
    recorder.current = null;
    setCurrent(l);
    setSubject(l.subject);
    setElapsed(l.duration);
    setRec(l.segments.length ? "paused" : "idle");
    setMessage(undefined);
  };

  const remove = (l: Lecture) => {
    if (!window.confirm(`「${l.subject || l.summary?.title || "授業"}」を消しますか？（元に戻せません）`)) return;
    deleteLecture(l.id);
    if (current?.id === l.id) finish();
    setLectures(loadLectures());
  };

  /** 脳（Obsidian）の「授業」フォルダに保存する。結果の一言を返す（保存できなければ理由） */
  const saveToBrain = async (l: Lecture): Promise<{ ok: boolean; text: string }> => {
    try {
      const res = await fetch("/api/lecture/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lecture: l, path: l.brainPath }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; path?: string; error?: string };
      if (!res.ok || !json.path) return { ok: false, text: json.error ?? `Obsidian に保存できませんでした（${res.status}）。` };
      const next = { ...(currentRef.current?.id === l.id ? currentRef.current : l), brainPath: json.path };
      if (currentRef.current?.id === l.id) setCurrent(next);
      persist(next);
      return { ok: true, text: `Obsidian に保存しました（${json.path}）。` };
    } catch {
      return { ok: false, text: "Obsidian に保存できませんでした（通信エラー）。" };
    }
  };

  const saveBrainNow = async () => {
    const l = currentRef.current;
    if (!l) return;
    setBusy("brain");
    setMessage(await saveToBrain(l));
    setBusy(null);
  };

  const summarize = async () => {
    const l = currentRef.current;
    if (!l) return;
    setBusy("summary");
    setMessage({ ok: true, text: "まとめています…（長い授業は 30 秒ほどかかります）" });
    try {
      const res = await fetch("/api/lecture/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: l.subject, transcript: transcriptText(l.segments), minutes: l.duration / 60 }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; summary?: LectureSummary; error?: string };
      if (!res.ok || !json.summary) throw new Error(json.error ?? `まとめを作れませんでした（${res.status}）。`);
      const next = { ...(currentRef.current ?? l), summary: json.summary };
      setCurrent(next);
      persist(next);
      // まとめたら、Obsidian の「授業」フォルダにも保存する（脳が接続されていなければ、まとめだけ）
      const saved = await saveToBrain(next);
      setMessage(
        saved.ok
          ? { ok: true, text: `まとめて、${saved.text.replace(/。$/, "")}。「PDF で保存」で書き出せます。` }
          : { ok: true, text: `まとめました。「PDF で保存」で書き出せます。（${saved.text.replace(/。$/, "")}）` },
      );
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "まとめを作れませんでした。" });
    } finally {
      setBusy(null);
    }
  };

  const downloadPdf = async () => {
    const l = currentRef.current;
    if (!l) return;
    setBusy("pdf");
    setMessage({ ok: true, text: "PDF を作っています…" });
    try {
      // PDF を作る部品は大きいので、使うときだけ読み込む
      const { lecturePdf, pdfName } = await import("@/lib/lecture-pdf");
      const blob = await lecturePdf(l, { transcript: withTranscript });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = pdfName(l);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage({ ok: true, text: `PDF を保存しました（${a.download}）。` });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "PDF を作れませんでした。" });
    } finally {
      setBusy(null);
    }
  };

  const s = current?.summary;
  const chars = current?.segments.reduce((n, x) => n + x.text.length, 0) ?? 0;

  return (
    <Page title="LECTURE" sub="授業の文字起こしと、まとめの PDF" hidden={hidden} message={message}>
      <Card title="RECORD" sub={rec === "recording" ? "● 録音中" : rec === "paused" ? "一時停止中" : "授業を始めるときに"} wide>
        <div className="lecture__controls">
          <input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              if (current) update((l) => ({ ...l, subject: e.target.value }));
            }}
            placeholder="科目名（例：線形代数）"
            aria-label="科目名"
          />
          <span className="lecture__clock" data-rec={rec === "recording" || undefined}>
            {clock(elapsed)}
          </span>
          {rec === "recording" ? (
            <button type="button" className="ghost-btn" onClick={pause}>
              一時停止
            </button>
          ) : (
            <button type="button" className="ghost-btn lecture__rec" onClick={start} disabled={!supported}>
              <Icon name="mic" size={13} /> {rec === "paused" ? "続きを録る" : "文字起こしを始める"}
            </button>
          )}
          {current && (
            <button type="button" className="ghost-btn" onClick={finish}>
              終えて保存
            </button>
          )}
        </div>
        {!supported && <Empty>このブラウザは文字起こしに対応していません。パソコンの Chrome（または Edge）で開いてください。</Empty>}
        <div className="lecture__text" ref={textRef} aria-live="polite">
          {current?.segments.length || interim ? (
            <>
              {current?.segments.map((seg, i) => (
                <p key={i}>
                  {(i === 0 || Math.floor(seg.t / 60) !== Math.floor(current.segments[i - 1].t / 60)) && <time>{clock(seg.t)}</time>}
                  {seg.text}
                </p>
              ))}
              {interim && <p className="lecture__interim">{interim}</p>}
            </>
          ) : (
            <p className="lecture__hint">
              「文字起こしを始める」を押すと、マイクで聞いた授業がここに文字で出ます。
              <br />
              先生の声が届きやすい席で、パソコンの画面は開いたままにしてください（録音中は画面が消えないようにします）。
              <br />
              音声は保存しません。文字にしたものはこのブラウザの中に保存し、「まとめる」と Obsidian の「授業」フォルダにも保存します。
            </p>
          )}
        </div>
        {current && (
          <div className="lecture__actions">
            <span className="lecture__meta">{chars.toLocaleString()} 文字</span>
            <button type="button" className="ghost-btn" onClick={() => void summarize()} disabled={busy !== null || chars < 20}>
              {busy === "summary" ? "まとめ中…" : s ? "まとめ直す" : "まとめる"}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void saveBrainNow()}
              disabled={busy !== null || chars < 1}
              title={current.brainPath ? `保存先：${current.brainPath}` : "Obsidian（脳）の「授業」フォルダに保存"}
            >
              <Icon name="brain" size={13} /> {busy === "brain" ? "保存中…" : current.brainPath ? "Obsidian に保存し直す" : "Obsidian に保存"}
            </button>
            <label className="lecture__check">
              <input type="checkbox" checked={withTranscript} onChange={(e) => setWithTranscript(e.target.checked)} /> 文字起こし全文も入れる
            </label>
            <button type="button" className="ghost-btn lecture__pdf" onClick={() => void downloadPdf()} disabled={busy !== null || (!s && !chars)}>
              <Icon name="doc" size={13} /> {busy === "pdf" ? "作成中…" : "PDF で保存"}
            </button>
          </div>
        )}
      </Card>

      {s && (
        <Card title="SUMMARY" sub={s.title} wide>
          <div className="lecture__summary">
            {s.overview && (
              <section>
                <h3>全体像</h3>
                <p className="lecture__overview">{s.overview}</p>
              </section>
            )}
            {s.keyPoints.length > 0 && (
              <section>
                <h3>重要なところ</h3>
                <ol>
                  {s.keyPoints.map((k, i) => (
                    <li key={i}>
                      <b>{k.point}</b>
                      {k.time && <time>{k.time}</time>}
                      {k.detail && <span>{k.detail}</span>}
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {s.exam.length > 0 && (
              <section>
                <h3>テストに出そうなところ</h3>
                <ul>
                  {s.exam.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </section>
            )}
            {s.outline.length > 0 && (
              <section>
                <h3>授業の流れ</h3>
                {s.outline.map((o, i) => (
                  <div key={i} className="lecture__part">
                    <b>
                      {o.time && <time>{o.time}</time>}
                      {o.heading}
                    </b>
                    <ul>
                      {o.points.map((p, j) => (
                        <li key={j}>{p}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            )}
            {s.terms.length > 0 && (
              <section>
                <h3>用語</h3>
                <dl>
                  {s.terms.map((t, i) => (
                    <div key={i}>
                      <dt>{t.term}</dt>
                      <dd>{t.meaning}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            {s.notices.length > 0 && (
              <section>
                <h3>課題・連絡</h3>
                <ul>
                  {s.notices.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </section>
            )}
            {s.review.length > 0 && (
              <section>
                <h3>復習チェック</h3>
                <ul>
                  {s.review.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </Card>
      )}

      <Card title="HISTORY" sub={`${lectures.length} 件`}>
        {lectures.length === 0 && <Empty>まだ授業はありません。</Empty>}
        <ul className="page-todos">
          {lectures.map((l) => (
            <li key={l.id} className="page-todo lecture__item" data-active={current?.id === l.id || undefined}>
              <button type="button" className="page-file" onClick={() => open(l)}>
                <Icon name="doc" size={13} /> {l.subject || l.summary?.title || "（科目名なし）"}
                <small>
                  {new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(l.startedAt))}・
                  {Math.max(1, Math.round(l.duration / 60))} 分{l.summary ? "・まとめ済み" : ""}
                </small>
              </button>
              <button type="button" className="ghost-btn" aria-label="この授業を消す" onClick={() => remove(l)} disabled={current?.id === l.id && rec === "recording"}>
                消す
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
});
