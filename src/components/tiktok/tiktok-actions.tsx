"use client";

import { LoaderCircleIcon, MusicIcon, RefreshCwIcon, Undo2Icon } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { useAction } from "@/components/production/use-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { creatorRewardsNote, TIKTOK_CAPTION_MAX, TIKTOK_PRIVACY_LABELS, type TikTokPostState, type TikTokPrivacyLevel } from "@/lib/tiktok";
import { forgetTikTokPost, getTikTokPostForm, publishToTikTok, refreshTikTokStatus, type TikTokPostForm } from "@/server/actions/tiktok";

const MUSIC_USAGE_URL = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
const BRANDED_CONTENT_URL = "https://www.tiktok.com/legal/page/global/bc-policy/en";
const NEEDS_DISCLOSURE_CHOICE = "You need to indicate if your content promotes yourself, a third party, or both.";
const BRANDED_NOT_PRIVATE = "Branded content visibility cannot be set to private.";

type Kind = "short" | "video";

/** One line under the title in the publishing queue: where the TikTok post stands. */
export function TikTokStatusLine({ state, url, error }: { state: TikTokPostState; url: string | null; error: string | null }) {
  if (state === "failed") return <p className="text-xs whitespace-normal text-orange-400">TikTok: {error ?? "posting failed"}</p>;
  return (
    <p className="text-xs text-muted-foreground">
      TikTok: {state === "uploading" ? "uploading…" : state === "processing" ? "processing" : "posted"}
      {url && (
        <>
          {" · "}
          <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            Open on TikTok
          </a>
        </>
      )}
    </p>
  );
}

export function TikTokActions({
  kind,
  id,
  title,
  videoUrl,
  state,
  connected,
}: {
  kind: Kind;
  id: string;
  title: string;
  /** The rendered file, for the preview TikTok requires before posting. */
  videoUrl: string | null;
  /** The latest TikTok post, or null when it was never posted. */
  state: TikTokPostState | null;
  /** A TikTok account is connected. */
  connected: boolean;
}) {
  const [pending, run] = useAction();
  const [loading, startLoading] = useTransition();
  const [form, setForm] = useState<TikTokPostForm | null>(null);

  function open() {
    // TikTok requires fresh creator info every time the post form opens.
    startLoading(async () => {
      try {
        const result = await getTikTokPostForm(kind, id);
        if (result.ok) setForm(result.form);
        else toast.error(result.message);
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <>
      {connected && (state === null || state === "failed") && (
        <Button size="sm" variant="outline" disabled={loading || pending} onClick={open}>
          {loading ? <LoaderCircleIcon className="animate-spin" /> : <MusicIcon />}
          {state === "failed" ? "Retry TikTok" : "Post to TikTok"}
        </Button>
      )}
      {connected && state === "processing" && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => refreshTikTokStatus(kind, id))}>
          <RefreshCwIcon />
          Check TikTok
        </Button>
      )}
      {(state === "processing" || state === "published" || state === "failed") && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => forgetTikTokPost(kind, id))}>
          <Undo2Icon />
          Forget TikTok post
        </Button>
      )}
      {form && (
        <PostDialog
          kind={kind}
          id={id}
          title={title}
          videoUrl={videoUrl}
          form={form}
          onClose={() => setForm(null)}
        />
      )}
    </>
  );
}

function PostDialog({
  kind,
  id,
  title,
  videoUrl,
  form,
  onClose,
}: {
  kind: Kind;
  id: string;
  title: string;
  videoUrl: string | null;
  form: TikTokPostForm;
  onClose: () => void;
}) {
  const [pending, run] = useAction();
  const { creator } = form;
  const [caption, setCaption] = useState(form.caption);
  // TikTok's rules: no visibility is preselected and every interaction starts unchecked.
  const [privacyLevel, setPrivacyLevel] = useState<TikTokPrivacyLevel | "">("");
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [disclose, setDisclose] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [brandedContent, setBrandedContent] = useState(false);
  const [isAigc, setIsAigc] = useState(form.isAigc);
  const [approved, setApproved] = useState(false);
  const htmlId = useId();
  const account = creator.nickname ?? creator.username ?? "the connected account";
  const branded = disclose && brandedContent;
  const length = [...caption].length;
  const rewards = creatorRewardsNote(form.durationSeconds);

  const disabledReason =
    form.blocker ??
    (disclose && !yourBrand && !brandedContent
      ? NEEDS_DISCLOSURE_CHOICE
      : !privacyLevel
        ? "Choose who can view this post"
        : length > TIKTOK_CAPTION_MAX
          ? `Shorten the caption to ${TIKTOK_CAPTION_MAX} characters`
          : !approved
            ? "Tick the approval box"
            : null);

  function post() {
    if (!privacyLevel) return;
    run(
      () =>
        publishToTikTok({
          kind,
          id,
          caption,
          privacyLevel,
          allowComment,
          allowDuet,
          allowStitch,
          disclose,
          yourBrand,
          brandedContent,
          isAigc,
          confirmed: approved as true,
        }),
      onClose,
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Post to TikTok</DialogTitle>
          <DialogDescription>
            Posts “{title}” to <span className="font-medium text-foreground">{account}</span>
            {creator.username && ` (@${creator.username})`}. Nothing is sent to TikTok until you click Post.
          </DialogDescription>
        </DialogHeader>

        {form.blocker && <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">{form.blocker}</p>}

        <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr]">
          {videoUrl ? (
            <video src={videoUrl} controls preload="metadata" className="max-h-80 w-full rounded-lg bg-black" />
          ) : (
            <div className="grid place-items-center rounded-lg border p-4 text-xs text-muted-foreground">No preview</div>
          )}

          <div className="grid content-start gap-4 text-sm">
            <div className="grid gap-1.5">
              <Label htmlFor={`${htmlId}-caption`}>Caption</Label>
              <Textarea id={`${htmlId}-caption`} rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} />
              <p className={`text-xs ${length > TIKTOK_CAPTION_MAX ? "text-rose-400" : "text-muted-foreground"}`}>
                {length} / {TIKTOK_CAPTION_MAX}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`${htmlId}-privacy`}>Who can view this post</Label>
              <Select value={privacyLevel} onValueChange={(v) => setPrivacyLevel(v as TikTokPrivacyLevel)}>
                <SelectTrigger id={`${htmlId}-privacy`} className="w-full">
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {creator.privacyLevelOptions.map((o) => (
                    <SelectItem key={o} value={o} disabled={o === "SELF_ONLY" && branded}>
                      {TIKTOK_PRIVACY_LABELS[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {branded && <p className="text-xs text-muted-foreground">{BRANDED_NOT_PRIVATE}</p>}
              {creator.privacyLevelOptions.length === 1 && creator.privacyLevelOptions[0] === "SELF_ONLY" && (
                <p className="text-xs text-amber-400">
                  Only “Only me” is offered: the account is private, or this TikTok app hasn&apos;t passed TikTok&apos;s audit yet.
                </p>
              )}
            </div>

            <fieldset className="grid gap-1.5">
              <legend className="mb-1.5 font-medium">Allow users to</legend>
              <Check label="Comment" checked={allowComment} onChange={setAllowComment} disabled={creator.commentDisabled} />
              <Check label="Duet" checked={allowDuet} onChange={setAllowDuet} disabled={creator.duetDisabled} />
              <Check label="Stitch" checked={allowStitch} onChange={setAllowStitch} disabled={creator.stitchDisabled} />
            </fieldset>

            <div className="grid gap-1.5">
              <Check
                label="Disclose commercial content"
                hint="Turn on if this post promotes yourself, a brand, product or service."
                checked={disclose}
                onChange={(v) => {
                  setDisclose(v);
                  if (!v) {
                    setYourBrand(false);
                    setBrandedContent(false);
                  }
                }}
              />
              {disclose && (
                <div className="grid gap-1.5 pl-6">
                  <Check label="Your brand" hint="You're promoting yourself or your own business." checked={yourBrand} onChange={setYourBrand} />
                  <Check
                    label="Branded content"
                    hint="You're promoting another brand or a third party."
                    checked={brandedContent}
                    onChange={(v) => {
                      setBrandedContent(v);
                      if (v && privacyLevel === "SELF_ONLY") setPrivacyLevel("");
                    }}
                  />
                  {(yourBrand || brandedContent) && (
                    <p className="text-xs text-muted-foreground">
                      Your post will be labeled “{brandedContent ? "Paid partnership" : "Promotional content"}”.
                    </p>
                  )}
                </div>
              )}
            </div>

            <Check
              label="AI-generated content"
              hint="Adds TikTok's “Creator labeled as AI-generated” label. Required for realistic AI-made content."
              checked={isAigc}
              onChange={setIsAigc}
            />

            {rewards && <p className="text-xs text-muted-foreground">Monetization: {rewards}</p>}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
            className="mt-0.5 size-3.5 shrink-0 accent-primary"
          />
          I approve posting this {kind === "short" ? "Short" : "video"} to {account} on TikTok now.
        </label>
        <p className="text-xs text-muted-foreground">
          By posting, you agree to TikTok&apos;s{" "}
          {branded && (
            <>
              <a href={BRANDED_CONTENT_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                Branded Content Policy
              </a>{" "}
              and{" "}
            </>
          )}
          <a href={MUSIC_USAGE_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            Music Usage Confirmation
          </a>
          . After posting, TikTok may take a few minutes to process it before it appears on the profile.
        </p>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <span title={disabledReason ?? undefined}>
            <Button disabled={pending || disabledReason !== null} onClick={post}>
              <MusicIcon />
              {pending ? "Posting…" : "Post"}
            </Button>
          </span>
        </DialogFooter>
        {disabledReason === NEEDS_DISCLOSURE_CHOICE && <p className="text-right text-xs text-amber-400">{NEEDS_DISCLOSURE_CHOICE}</p>}
      </DialogContent>
    </Dialog>
  );
}

function Check({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? "opacity-50" : ""}`} title={disabled ? "Turned off in this account's TikTok settings" : undefined}>
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-primary"
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}
