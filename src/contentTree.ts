/** Course files live under this path; anything else is an external link. */
export const ENFORCED_CONTENT_PREFIX = "/content/enforced/";

export interface RawTopic {
  readonly TopicId?: number;
  readonly Title?: string;
  readonly TypeIdentifier?: string;
  readonly Url?: string | null;
  readonly IsHidden?: boolean;
  readonly LastModifiedDate?: string | null;
}

export interface RawModule {
  readonly ModuleId?: number;
  readonly Title?: string;
  readonly IsHidden?: boolean;
  readonly Modules?: RawModule[];
  readonly Topics?: RawTopic[];
}

export interface ContentTopic {
  readonly topicId: string;
  readonly title: string;
  /** Module titles from the root down, e.g. ["Lectures", "Week 1"]. */
  readonly modulePath: readonly string[];
  readonly type: string;
  readonly url: string | null;
  /** True when the topic is a file hosted by LEARN and can be downloaded. */
  readonly isFile: boolean;
  readonly extension: string | null;
}

const extensionOf = (url: string | null): string | null => {
  if (!url) return null;
  const match = /\.([A-Za-z0-9]{1,8})(?:$|\?)/.exec(url);
  return match ? match[1].toLowerCase() : null;
};

/**
 * Walks the content table of contents into a flat topic list.
 *
 * Hidden modules hide their topics, so the recursion stops rather than
 * descending and surfacing material the instructor withheld.
 */
export function flattenToc(modules: readonly RawModule[] | undefined): ContentTopic[] {
  const topics: ContentTopic[] = [];

  const visit = (module: RawModule, ancestry: readonly string[]): void => {
    if (module.IsHidden === true) return;

    const modulePath = [...ancestry, module.Title ?? "Untitled module"];

    for (const topic of module.Topics ?? []) {
      if (topic.IsHidden === true) continue;
      const url = topic.Url ?? null;
      topics.push({
        topicId: String(topic.TopicId ?? ""),
        title: topic.Title ?? "Untitled topic",
        modulePath,
        type: topic.TypeIdentifier ?? "Unknown",
        url,
        isFile: Boolean(url?.startsWith(ENFORCED_CONTENT_PREFIX)),
        extension: extensionOf(url)
      });
    }

    for (const child of module.Modules ?? []) visit(child, modulePath);
  };

  for (const module of modules ?? []) visit(module, []);
  return topics;
}
