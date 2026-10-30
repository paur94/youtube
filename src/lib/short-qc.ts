import {
  type CaptionCue,
  findMetadataConcerns,
  HASHTAGS_IGNORED_ABOVE,
  HASHTAGS_RECOMMENDED_MAX,
  SHORT_COMFORT_SECONDS,
  SHORT_MAX_SECONDS,
  type ShortAnalysis,
  validateCaptions,
  type VideoSettings,
} from "./shorts";
import { type AudioLevels, computeFraming, isVertical916, type MediaProbe, OUT_H, OUT_W } from "./short-video";

export type CheckStatus = "pass" | "warn" | "fail" | "unavailable";

export type QualityCheck = {
  id:
    | "render"
    | "duration"
    | "aspect"
    | "resolution"
    | "framing"
    | "audio"
    | "captions"
    | "opening"
    | "story"
    | "children"
    | "metadata";
  label: string;
  status: CheckStatus;
  details: string[];
};

export type QualityInput = {
  sourceProbe: MediaProbe | null;
  outputProbe: MediaProbe | null;
  outputAudio: AudioLevels | null;
  /** True when the render matches the current settings, captions and hook. */
  renderCurrent: boolean;
  rendered: boolean;
  settings: VideoSettings;
  captions: CaptionCue[];
  captionsReviewed: boolean;
  hasDialogue: boolean;
  hook: string;
  analysis: ShortAnalysis | null;
  metadata: { title: string; description: string; hashtags: string[] };
  metadataApproved: boolean;
  ffmpegAvailable: boolean;
};

function check(id: QualityCheck["id"], label: string, status: CheckStatus, details: string[]): QualityCheck {
  return { id, label, status, details };
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

export function evaluateQuality(input: QualityInput): QualityCheck[] {
  const checks: QualityCheck[] = [];
  const out = input.rendered ? input.outputProbe : null;
  const src = input.sourceProbe;

  // Render
  if (!input.rendered) {
    checks.push(
      check("render", "Vertical render", input.ffmpegAvailable ? "fail" : "unavailable", [
        input.ffmpegAvailable
          ? "Not rendered yet. Render the 9:16 version to check the final file."
          : "FFmpeg isn't installed, so the vertical version can't be rendered or measured. See the README.",
      ]),
    );
  } else if (!input.renderCurrent) {
    checks.push(check("render", "Vertical render", "fail", ["Settings, captions, hook or source changed since the last render. Render again."]));
  } else {
    checks.push(check("render", "Vertical render", "pass", ["Rendered with the current settings. The original clip is unchanged."]));
  }

  // Duration
  const duration = out?.durationSeconds ?? src?.durationSeconds ?? null;
  if (duration === null) {
    checks.push(check("duration", "Duration", "unavailable", ["Duration unknown until the video is probed with FFmpeg."]));
  } else if (duration > SHORT_MAX_SECONDS) {
    checks.push(check("duration", "Duration", "fail", [`${f1(duration)}s is longer than the 3-minute Shorts limit.`]));
  } else if (duration > SHORT_COMFORT_SECONDS) {
    checks.push(check("duration", "Duration", "warn", [`${f1(duration)}s. Allowed as a Short, but check it holds attention for over a minute.`]));
  } else if (duration < 5) {
    checks.push(check("duration", "Duration", "warn", [`${f1(duration)}s is very short. Check there is enough story to follow.`]));
  } else {
    checks.push(check("duration", "Duration", "pass", [`${f1(duration)}s${out ? "" : " (source clip; render to confirm)"}.`]));
  }

  // Aspect ratio
  if (out) {
    checks.push(
      isVertical916(out.width, out.height)
        ? check("aspect", "Vertical 9:16", "pass", [`${out.width}×${out.height}.`])
        : check("aspect", "Vertical 9:16", "fail", [`Output is ${out.width}×${out.height}, not 9:16.`]),
    );
  } else {
    checks.push(
      check("aspect", "Vertical 9:16", "unavailable", [
        src?.width ? `Source is ${src.width}×${src.height}. Render to produce the 9:16 version.` : "Render to produce the 9:16 version.",
      ]),
    );
  }

  // Resolution and upscaling
  const sourceW = src?.width ?? null;
  const sourceH = src?.height ?? null;
  const framing = sourceW && sourceH ? computeFraming(sourceW, sourceH, input.settings) : null;
  if (out?.width && out.height) {
    const details: string[] = [`Output ${out.width}×${out.height}.`];
    let status: CheckStatus = "pass";
    if (out.width < 720 || out.height < 1280) status = "fail";
    else if (out.width < OUT_W || out.height < OUT_H) status = "warn";
    if (framing && framing.scale > 1.5) {
      status = status === "fail" ? "fail" : "warn";
      details.push(`The source (${sourceW}×${sourceH}) is enlarged ${f1(framing.scale)}×, so detail will look soft. Zoom out to keep it sharper.`);
    }
    checks.push(check("resolution", "Resolution", status, details));
  } else {
    checks.push(
      check("resolution", "Resolution", "unavailable", [sourceW ? `Source ${sourceW}×${sourceH}; render to check the output.` : "Not measured yet."]),
    );
  }

  // Framing: never silently crop characters out.
  if (!framing) {
    checks.push(check("framing", "Characters and action in frame", "unavailable", ["Source size unknown until the clip is probed."]));
  } else if (framing.croppedFraction < 0.005) {
    checks.push(check("framing", "Characters and action in frame", "pass", ["The whole original frame is visible (blurred background fills the rest)."]));
  } else {
    checks.push(
      check("framing", "Characters and action in frame", "warn", [
        `${Math.round(framing.croppedFraction * 100)}% of the original picture is cut off. Watch the final preview and confirm no character or key action leaves the frame.`,
      ]),
    );
  }

  // Audio
  const audioProbe = out ?? src;
  if (!audioProbe) {
    checks.push(check("audio", "Audio", "unavailable", ["Not measured yet."]));
  } else if (!audioProbe.hasAudio) {
    checks.push(check("audio", "Audio", "fail", ["The video has no audio track."]));
  } else if (!input.outputAudio || !out) {
    checks.push(check("audio", "Audio", "unavailable", ["Has an audio track. Loudness is measured when the vertical version is rendered."]));
  } else if (input.outputAudio.silent) {
    checks.push(check("audio", "Audio", "fail", ["The audio track is silent."]));
  } else {
    const a = input.outputAudio;
    const details: string[] = [];
    let status: CheckStatus = "pass";
    if (a.integratedLufs !== null) {
      details.push(`Loudness ${f1(a.integratedLufs)} LUFS (target about -14).`);
      if (a.integratedLufs < -24 || a.integratedLufs > -9) {
        status = "warn";
        details.push(a.integratedLufs < -24 ? "Too quiet: turn on loudness normalisation." : "Very loud: turn on loudness normalisation.");
      }
    }
    if (a.truePeakDbfs !== null) {
      details.push(`True peak ${f1(a.truePeakDbfs)} dBFS.`);
      if (a.truePeakDbfs > -0.5) {
        status = "warn";
        details.push("Peaks close to 0 dBFS can distort.");
      }
    }
    details.push("Listen once for garbled or wrong-speaker lines: generated voices can't be checked automatically.");
    checks.push(check("audio", "Audio", status, details));
  }

  // Captions
  if (!input.captions.length) {
    checks.push(
      check("captions", "Captions", input.hasDialogue ? "warn" : "pass", [
        input.hasDialogue ? "The scene has dialogue but no captions." : "No dialogue, so no captions needed.",
      ]),
    );
  } else {
    const issues = validateCaptions(input.captions, duration);
    const details = issues.map((i) => i.message);
    let status: CheckStatus = issues.some((i) => i.level === "fail") ? "fail" : issues.length ? "warn" : "pass";
    if (!input.captionsReviewed) {
      if (status === "pass") status = "warn";
      details.push("Timing is estimated from word counts. Play the preview, adjust the times, then tick “Captions match the audio”.");
    } else {
      details.push(`${input.captions.length} captions, checked against the audio.`);
    }
    if (!input.settings.burnCaptions) details.push("Not burned in: upload captions.srt to YouTube as a caption track.");
    checks.push(check("captions", "Caption sync", status, details));
  }

  // Opening seconds and storytelling (Claude reads the script; it can't watch the video).
  const a = input.analysis;
  if (!a) {
    checks.push(check("opening", "Opening seconds", "unavailable", ["Run the Claude analysis."]));
    checks.push(check("story", "Standalone storytelling", "unavailable", ["Run the Claude analysis."]));
    checks.push(check("children", "Children's suitability", "unavailable", ["Run the Claude analysis, then review it yourself."]));
  } else {
    checks.push(
      check("opening", "Opening seconds", a.opening.strength === "weak" ? "warn" : "pass", [
        a.opening.note,
        ...(input.hook.trim() ? [`Hook: “${input.hook.trim()}”.`] : ["No on-screen hook set."]),
      ]),
    );
    const storyDetails = [...a.standalone.reasons];
    if (!a.structure.clearArc) storyDetails.push(`No clear beginning, middle and ending: ${a.structure.note}`);
    checks.push(
      check(
        "story",
        "Standalone storytelling",
        a.standalone.verdict === "weak" || !a.structure.clearArc ? "warn" : "pass",
        storyDetails.length ? storyDetails : [a.structure.note],
      ),
    );
    checks.push(
      check("children", "Children's suitability", a.childSafety.status === "concern" ? "fail" : "pass", [
        a.childSafety.notes,
        "Claude's review is advisory; your own review is the real check.",
      ]),
    );
  }

  // Metadata
  const metaDetails: string[] = [];
  let metaStatus: CheckStatus = "pass";
  const concerns = findMetadataConcerns({ ...input.metadata, hook: input.hook });
  if (concerns.length) {
    metaStatus = "fail";
    metaDetails.push(...concerns);
  }
  if (!input.metadata.title.trim()) {
    metaStatus = "fail";
    metaDetails.push("Title is empty.");
  }
  if (input.metadata.hashtags.length > HASHTAGS_IGNORED_ABOVE) {
    metaStatus = "fail";
    metaDetails.push(`YouTube ignores all hashtags when there are more than ${HASHTAGS_IGNORED_ABOVE}.`);
  } else if (input.metadata.hashtags.length > HASHTAGS_RECOMMENDED_MAX) {
    if (metaStatus === "pass") metaStatus = "warn";
    metaDetails.push(`${input.metadata.hashtags.length} hashtags; a few relevant ones work better.`);
  }
  if (!input.metadataApproved) {
    if (metaStatus === "pass") metaStatus = "warn";
    metaDetails.push("Metadata isn't approved yet.");
  } else if (metaStatus === "pass") {
    metaDetails.push("Approved.");
  }
  checks.push(check("metadata", "Title, description and hashtags", metaStatus, metaDetails));

  return checks;
}

export function summarizeQuality(checks: QualityCheck[]) {
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  return { pass: count("pass"), warn: count("warn"), fail: count("fail"), unavailable: count("unavailable") };
}

/** Why a Short can't be approved yet; empty when it can. */
export function approvalBlockers(checks: QualityCheck[], input: { rendered: boolean; metadataApproved: boolean }) {
  const blockers: string[] = [];
  if (!input.rendered) blockers.push("Render the vertical version first.");
  if (!input.metadataApproved) blockers.push("Approve the metadata first.");
  for (const c of checks) if (c.status === "fail") blockers.push(`${c.label}: ${c.details[0] ?? "failed"}`);
  return [...new Set(blockers)];
}
