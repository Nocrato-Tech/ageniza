import { z } from 'zod';

/**
 * A client's story scripts (specs/conteudo.md sections 3, 4 and 6, issue #258): one script per day of
 * stories, a few ordered scenes, `draft -> sent -> recorded`. The agency writes and sends; the portal reads
 * what was sent and marks it recorded. The portal's schemas below have no `draft` and no scene id, so the
 * contract itself says what the portal never receives (rule 1).
 */

/** Scenes in one script. The SPEC fixes no number; 30 is the choice recorded in `docs/business/decisions/`. */
export const STORY_SCRIPT_MAX_SCENES = 30;
export const STORY_SCENE_TEXT_MAX_LENGTH = 2000;
export const STORY_SCENE_GUIDANCE_MAX_LENGTH = 1000;

/** The period query's two ceilings (decision of #254): 93 days, both ends included, and 500 items. */
export const STORY_SCRIPT_PERIOD_MAX_DAYS = 93;
export const STORY_SCRIPT_PERIOD_MAX_ITEMS = 500;

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real day of the Gregorian calendar ('2026-02-30' and year 0000 are not), in the shape the `date` column prints. */
const isCalendarDay = (value: string): boolean => {
  const parts = CALENDAR_DAY.exec(value);
  if (parts === null) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (year < 1) return false;
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

const DaySchema = z.string().refine(isCalendarDay, 'must be a real date in the form YYYY-MM-DD');

/** Tab, LF and CR are the line breaks a person types; every other control character is refused. */
const LINE_BREAKS = /[\t\n\r]/g;
const CONTROL_OR_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/** Every format character: the zero-width space and joiners, the bidi controls, the BOM and the soft hyphen. */
const FORMAT_CHARACTER = /\p{Cf}/u;
/**
 * What the format rule above does not reach and still renders as nothing: the combining grapheme joiner, the
 * variation selectors, the Hangul fillers and the like (`Default_Ignorable_Code_Point` that is not `Cf`), and the
 * Braille blank. The one exception is VS16 right after a pictograph, which is how a phone writes a heart.
 */
const IGNORABLE_NOT_FORMAT = /(?!\p{Cf})[\p{Default_Ignorable_Code_Point}\u2800]/u;
const EMOJI_PRESENTATION = /(?<=\p{Extended_Pictographic})\uFE0F/gu;

/** Whether a free text carries a character that is invisible, forged-looking or breaks the line it is on. */
export const hasHiddenStoryCharacters = (value: string): boolean => {
  const withoutLineBreaks = value.replace(LINE_BREAKS, '');
  return CONTROL_OR_SEPARATOR.test(withoutLineBreaks)
    || FORMAT_CHARACTER.test(withoutLineBreaks)
    || IGNORABLE_NOT_FORMAT.test(withoutLineBreaks.replace(EMOJI_PRESENTATION, ''));
};

const visibleText = () => z.string().refine((value) => !hasHiddenStoryCharacters(value), 'must not contain control or invisible characters');

/** A scene's text: trimmed, not empty, bounded. The database refuses only a blank one. */
export const StorySceneTextSchema = visibleText()
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'must not be empty').max(STORY_SCENE_TEXT_MAX_LENGTH));

/** The guidance is optional: absent, null, empty and whitespace-only are all "no guidance", stored as null. */
export const StorySceneGuidanceSchema = visibleText()
  .transform((value) => value.trim())
  .pipe(z.string().max(STORY_SCENE_GUIDANCE_MAX_LENGTH))
  .transform((value) => (value === '' ? null : value))
  .nullish()
  .transform((value) => value ?? null);

export const StorySceneInputSchema = z.object({
  text: StorySceneTextSchema,
  guidance: StorySceneGuidanceSchema
}).strict();

/**
 * A scene of an edit: with `id`, an existing scene (its text, guidance and place change); without it, a new
 * one. The list is the whole script in its new order, because a scene is never removed.
 */
export const StorySceneEditSchema = z.object({
  id: z.string().uuid().optional(),
  text: StorySceneTextSchema,
  guidance: StorySceneGuidanceSchema
}).strict();

export const CreateStoryScriptRequestSchema = z.object({
  scriptOn: DaySchema,
  scenes: z.array(StorySceneInputSchema).max(STORY_SCRIPT_MAX_SCENES).default([])
}).strict();

export const UpdateStoryScriptRequestSchema = z.object({
  scriptOn: DaySchema.optional(),
  scenes: z.array(StorySceneEditSchema).max(STORY_SCRIPT_MAX_SCENES).optional()
}).strict()
  .refine((value) => value.scriptOn !== undefined || value.scenes !== undefined, 'at least one field must be provided')
  .refine(
    (value) => {
      const ids = (value.scenes ?? []).flatMap((scene) => (scene.id === undefined ? [] : [scene.id]));
      return new Set(ids).size === ids.length;
    },
    'a scene appears once'
  );

export const StoryScriptStatusSchema = z.enum(['draft', 'sent', 'recorded']);

const RecordedBySchema = z.object({ name: z.string().nullable() }).strict();

export const StorySceneSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().positive(),
  text: z.string(),
  guidance: z.string().nullable()
}).strict();

/** The agency's view of a script. */
export const StoryScriptSchema = z.object({
  id: z.string().uuid(),
  scriptOn: z.string(),
  status: StoryScriptStatusSchema,
  scenes: z.array(StorySceneSchema),
  recordedBy: RecordedBySchema.nullable(),
  recordedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime()
}).strict();

export const PortalStorySceneSchema = z.object({
  position: z.number().int().positive(),
  text: z.string(),
  guidance: z.string().nullable()
}).strict();

/** The portal's view of a script: only `sent` or `recorded`, and nothing about who wrote it. */
export const PortalStoryScriptSchema = z.object({
  id: z.string().uuid(),
  scriptOn: z.string(),
  status: z.enum(['sent', 'recorded']),
  scenes: z.array(PortalStorySceneSchema),
  recordedBy: RecordedBySchema.nullable(),
  recordedAt: z.string().datetime().nullable()
}).strict();

export const AgencyClientStoryScriptPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  clientId: z.string().uuid(),
  scriptId: z.string().uuid()
}).strict();

export const ClientStoryScriptPathParamsSchema = z.object({
  clientId: z.string().uuid(),
  scriptId: z.string().uuid()
}).strict();

/**
 * The period of the portal's listing, both ends included (`AAAA-MM-DD`). It stays a plain strict object so the
 * generated documentation can list each parameter; the ceilings are `storyScriptPeriodIssues`, which the route
 * calls right after validating.
 */
export const StoryScriptPeriodQuerySchema = z.object({
  from: DaySchema,
  to: DaySchema
}).strict();

export type StoryScriptPeriodQuery = z.infer<typeof StoryScriptPeriodQuerySchema>;

const DAY_MS = 86_400_000;

/** The days a period spans, both ends included. Only for two real calendar days. */
export const storyScriptPeriodDays = (query: StoryScriptPeriodQuery): number =>
  Math.round((Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / DAY_MS) + 1;

/** What is wrong with a period beyond its two days: it runs backwards, or it spans more than 93 days. */
export const storyScriptPeriodIssues = (query: StoryScriptPeriodQuery): readonly { readonly path: string; readonly message: string }[] => {
  const days = storyScriptPeriodDays(query);
  if (days < 1) return [{ path: 'to', message: 'must not be before from' }];
  if (days > STORY_SCRIPT_PERIOD_MAX_DAYS) return [{ path: 'to', message: `the period must span at most ${STORY_SCRIPT_PERIOD_MAX_DAYS} days` }];
  return [];
};

export const PortalStoryScriptPeriodResponseSchema = z.object({
  data: z.array(PortalStoryScriptSchema),
  meta: z.object({
    from: z.string(),
    to: z.string(),
    count: z.number().int().nonnegative()
  }).strict()
}).strict();

export type CreateStoryScriptRequest = z.infer<typeof CreateStoryScriptRequestSchema>;
export type UpdateStoryScriptRequest = z.infer<typeof UpdateStoryScriptRequestSchema>;
export type StoryScript = z.infer<typeof StoryScriptSchema>;
export type StoryScene = z.infer<typeof StorySceneSchema>;
export type PortalStoryScript = z.infer<typeof PortalStoryScriptSchema>;
