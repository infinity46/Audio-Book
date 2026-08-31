/**
 * Renders the canonical structural tree to Markdown (task §53/§54/§132):
 * a derived, human-readable artifact for review/download — never the
 * source of truth for downstream processing, which reads the structured
 * chapter/section/paragraph rows directly.
 */
import type { CanonicalChapter } from '../structure/detect-structure.js';

export function renderMarkdown(chapters: CanonicalChapter[]): string {
  const parts: string[] = [];

  for (const chapter of chapters) {
    parts.push(`# ${chapter.title ?? `Chapter ${chapter.orderIndex + 1}`}`);
    parts.push('');

    let currentSection: number | undefined;
    for (const paragraph of chapter.paragraphs) {
      if (paragraph.sectionOrderIndex !== currentSection) {
        currentSection = paragraph.sectionOrderIndex;
        const section = chapter.sections.find((s) => s.orderIndex === currentSection);
        if (section?.title) {
          parts.push(`## ${section.title}`);
          parts.push('');
        }
      }
      parts.push(paragraph.text);
      parts.push('');
    }
  }

  return parts.join('\n').trim() + '\n';
}
