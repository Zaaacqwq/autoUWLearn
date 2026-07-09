import { z } from "zod";

export const AuthStatusSchema = z.object({
  ok: z.boolean(),
  authenticated: z.boolean(),
  state: z.string(),
  url: z.string(),
  title: z.string(),
  message: z.string(),
  authUrl: z.string()
}).passthrough();

export const CourseSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().optional(),
  semester: z.string().optional(),
  url: z.string(),
  raw: z.unknown().optional()
}).passthrough();

export const NormalizedCourseSchema = z.object({
  courseId: z.string(),
  courseName: z.string(),
  courseCode: z.string().optional(),
  semester: z.string().optional(),
  url: z.string()
}).passthrough();

export const LinkSchema = z.object({
  label: z.string(),
  url: z.string()
}).passthrough();

export const DueItemSchema = z.object({
  courseId: z.string(),
  courseName: z.string(),
  courseCode: z.string().optional(),
  type: z.enum(["assignment", "quiz", "calendar", "content", "update"]),
  title: z.string(),
  dueAt: z.string().optional(),
  dueText: z.string().optional(),
  status: z.string().optional(),
  url: z.string().optional(),
  source: z.string()
}).passthrough();

export const DueDatesSchema = z.object({
  dueDateLines: z.array(z.string()).optional(),
  items: z.array(DueItemSchema),
  itemCount: z.number().optional(),
  status: z.string(),
  query: z.string().optional(),
  matches: z.array(NormalizedCourseSchema).optional(),
  daysAhead: z.number().optional(),
  errorCount: z.number().optional(),
  errors: z.array(z.object({
    courseId: z.string(),
    source: z.string(),
    message: z.string()
  }).passthrough()).optional(),
  checkedCourseCount: z.number().optional(),
  checkedCourses: z.array(z.object({
    courseId: z.string(),
    courseName: z.string(),
    courseCode: z.string().optional()
  }).passthrough()).optional()
}).passthrough();

export const CoursesResultSchema = z.object({
  source: z.string(),
  status: z.number(),
  courses: z.array(CourseSchema),
  raw: z.unknown().optional(),
  parseError: z.string().optional(),
  preview: z.string().optional()
}).passthrough();

export const CourseResolutionSchema = z.object({
  query: z.string(),
  matchCount: z.number(),
  matches: z.array(NormalizedCourseSchema)
}).passthrough();

export const AnnouncementSchema = z.object({
  courseId: z.string(),
  courseName: z.string(),
  courseCode: z.string().optional(),
  title: z.string(),
  postedAt: z.string().optional(),
  body: z.string(),
  contentStatus: z.enum(["full", "unavailable"]).optional(),
  attachments: z.array(LinkSchema).optional(),
  warning: z.string().optional(),
  url: z.string().optional(),
  source: z.string()
}).passthrough();

export const AnnouncementsResultSchema = z.object({
  status: z.string(),
  query: z.string().optional(),
  course: NormalizedCourseSchema.optional(),
  matches: z.array(NormalizedCourseSchema).optional(),
  announcements: z.array(AnnouncementSchema)
}).passthrough();

export const ParsedPageSchema = z.object({
  source: z.string(),
  status: z.number(),
  contentType: z.string().optional(),
  title: z.string(),
  emptyState: z.string().optional(),
  rows: z.array(z.record(z.string(), z.string())),
  links: z.array(LinkSchema),
  text: z.string()
}).passthrough();

export const CourseHomeSchema = z.object({
  source: z.string(),
  status: z.number(),
  title: z.string(),
  links: z.array(LinkSchema),
  nav: z.array(LinkSchema),
  announcements: z.array(z.string()),
  updates: z.array(z.string())
}).passthrough();

export const ContentTopicSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  url: z.string(),
  type: z.string().optional(),
  fileUrl: z.string().optional()
}).passthrough();

export const ContentModuleSchema: z.ZodTypeAny = z.lazy(() => z.object({
  id: z.string().optional(),
  title: z.string(),
  url: z.string().optional(),
  topics: z.array(ContentTopicSchema),
  modules: z.array(ContentModuleSchema)
}).passthrough());

export const ContentResultSchema = z.object({
  source: z.string(),
  status: z.number(),
  title: z.string(),
  modules: z.array(ContentModuleSchema),
  topics: z.array(ContentTopicSchema),
  links: z.array(LinkSchema)
}).passthrough();

export const ContentItemResultSchema = z.object({
  source: z.string(),
  status: z.number(),
  title: z.string(),
  text: z.string(),
  links: z.array(LinkSchema),
  fileUrls: z.array(z.string())
}).passthrough();

export const DownloadResultSchema = z.object({
  url: z.string(),
  status: z.number(),
  contentType: z.string(),
  bytes: z.number(),
  path: z.string()
}).passthrough();

export const DashboardSchema = z.object({
  status: z.string(),
  daysAhead: z.number().optional(),
  query: z.string().optional(),
  course: NormalizedCourseSchema.optional(),
  courses: z.array(NormalizedCourseSchema).optional(),
  dueItems: z.array(DueItemSchema).optional(),
  dueErrors: z.array(z.unknown()).optional(),
  latestAnnouncements: z.array(AnnouncementSchema).optional(),
  summaries: z.array(z.unknown()).optional(),
  errors: z.array(z.unknown()).optional(),
  nav: z.array(LinkSchema).optional()
}).passthrough();

export const GenericObjectSchema = z.record(z.string(), z.unknown());

export function schemaToJson(schema: z.ZodTypeAny): unknown {
  return z.toJSONSchema(schema);
}
