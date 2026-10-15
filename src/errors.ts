// Discord only ever shows the code; what it means stays in this file and in the logs.
export const ERROR_CODES = {
  E100: "command handler threw an unexpected exception",
  E101: "queue manager interaction threw an unexpected exception",
  E201: "YouTube bot check: the cookies are signed out, rotated or missing",
  E202: "video unavailable: private, removed, members-only or terminated",
  E203: "video is age-restricted and the cookie account cannot confirm age",
  E204: "video is blocked in the host's country",
  E205: "live stream or premiere, which are not supported",
  E206: "video has no audio-only format",
  E207: "YouTube rate-limited or refused the request (HTTP 403/429)",
  E208: "yt-dlp timed out while resolving the video",
  E209: "yt-dlp returned empty or malformed metadata",
  E299: "yt-dlp failed for an unclassified reason",
  E301: "audio pipeline (yt-dlp → ffmpeg) could not be started",
  E302: "audio stream failed during playback",
  E303: "audio player emitted an error",
  E401: "could not join the voice channel",
  E402: "voice connection was lost",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

const YTDLP_PATTERNS: readonly (readonly [RegExp, ErrorCode])[] = [
  [/Sign in to confirm you.re not a bot/i, "E201"],
  [/Sign in to confirm your age|age.restricted|inappropriate for some users/i, "E203"],
  [
    /not made this video available in your country|blocked it in your country|geo.?restrict/i,
    "E204",
  ],
  [/live event will begin|Premieres in|is_live|is_upcoming/i, "E205"],
  [/Requested format is not available/i, "E206"],
  [/HTTP Error (403|429)|Too Many Requests/i, "E207"],
  [
    /Video unavailable|Private video|has been removed|no longer available|members.only|account .* terminated/i,
    "E202",
  ],
];

export function classifyYtDlpError(message: string): ErrorCode {
  return YTDLP_PATTERNS.find(([pattern]) => pattern.test(message))?.[1] ?? "E299";
}

export interface ErrorFields {
  readonly errorCode: ErrorCode;
  readonly errorClass: string;
}

export function errorFields(code: ErrorCode): ErrorFields {
  return { errorCode: code, errorClass: ERROR_CODES[code] };
}

export function userMessage(summary: string, code: ErrorCode): string {
  return `⚠️ ${summary} Error code \`${code}\`.`;
}
