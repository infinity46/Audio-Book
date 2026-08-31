/**
 * Builds the BookVersion.textQc report (task §66/§93/§94/§130): flags
 * anomalies for human review rather than silently accepting or rejecting.
 * Chapters are identified by their orderIndex here (the pipeline has no
 * database identity yet) — the persistence layer may remap to real
 * chapter UUIDs when it writes this JSON, if that's useful downstream.
 */
import type { ExtractedPage } from './model.js';
import type { CanonicalChapter } from './structure/detect-structure.js';

export type QcOutcome = 'PASS' | 'WARN' | 'NEEDS_REVIEW';

export interface QcCheck {
  check: string;
  outcome: QcOutcome;
  affected_chapter_ids: number[];
  detail?: string;
}

export interface QualityReport {
  outcome: QcOutcome;
  checks: QcCheck[];
}

const OUTCOME_RANK: Record<QcOutcome, number> = { PASS: 0, WARN: 1, NEEDS_REVIEW: 2 };

export function buildQualityReport(
  chapters: CanonicalChapter[],
  rawCharCount: number,
  normalizedCharCount: number,
  pages: ExtractedPage[] | undefined,
): QualityReport {
  const checks: QcCheck[] = [
    checkContentLossRatio(rawCharCount, normalizedCharCount),
    checkEmptyChapters(chapters),
    checkDuplicateParagraphs(chapters),
  ];
  if (pages) checks.push(checkPageCoverage(pages));

  const outcome = checks.reduce<QcOutcome>(
    (worst, c) => (OUTCOME_RANK[c.outcome] > OUTCOME_RANK[worst] ? c.outcome : worst),
    'PASS',
  );

  return { outcome, checks };
}

function checkContentLossRatio(rawCharCount: number, normalizedCharCount: number): QcCheck {
  if (rawCharCount === 0) {
    return { check: 'content_loss_ratio', outcome: 'PASS', affected_chapter_ids: [] };
  }
  const retained = normalizedCharCount / rawCharCount;
  const outcome: QcOutcome = retained < 0.4 ? 'NEEDS_REVIEW' : retained < 0.7 ? 'WARN' : 'PASS';
  return {
    check: 'content_loss_ratio',
    outcome,
    affected_chapter_ids: [],
    detail: `retained ${(retained * 100).toFixed(1)}% of raw extracted characters after normalization`,
  };
}

function checkEmptyChapters(chapters: CanonicalChapter[]): QcCheck {
  const empty = chapters.filter((c) => c.paragraphs.length === 0).map((c) => c.orderIndex);
  return {
    check: 'empty_chapters',
    outcome: empty.length > 0 ? 'NEEDS_REVIEW' : 'PASS',
    affected_chapter_ids: empty,
  };
}

function checkDuplicateParagraphs(chapters: CanonicalChapter[]): QcCheck {
  const seen = new Map<string, number>(); // normalized text -> chapter orderIndex first seen in
  const affected = new Set<number>();

  for (const chapter of chapters) {
    for (const paragraph of chapter.paragraphs) {
      if (paragraph.text.length < 40) continue; // short repeated lines (e.g. "Yes.") are not meaningful duplicates
      const existingChapter = seen.get(paragraph.text);
      if (existingChapter !== undefined) {
        affected.add(existingChapter);
        affected.add(chapter.orderIndex);
      } else {
        seen.set(paragraph.text, chapter.orderIndex);
      }
    }
  }

  return {
    check: 'duplicate_paragraphs',
    outcome: affected.size > 0 ? 'WARN' : 'PASS',
    affected_chapter_ids: [...affected].sort((a, b) => a - b),
  };
}

function checkPageCoverage(pages: ExtractedPage[]): QcCheck {
  const pageNumbers = pages.map((p) => p.pageNumber).sort((a, b) => a - b);
  const maxPage = pageNumbers[pageNumbers.length - 1] ?? 0;
  const covered = new Set(pageNumbers);
  const missing: number[] = [];
  for (let n = 1; n <= maxPage; n += 1) {
    if (!covered.has(n)) missing.push(n);
  }
  const needsReviewPages = pages.filter((p) => p.status !== 'OK').length;

  const outcome: QcOutcome =
    missing.length > 0 ? 'NEEDS_REVIEW' : needsReviewPages > 0 ? 'WARN' : 'PASS';
  return {
    check: 'page_coverage',
    outcome,
    affected_chapter_ids: [],
    detail:
      missing.length > 0
        ? `missing pages: ${missing.join(',')}`
        : needsReviewPages > 0
          ? `${needsReviewPages} page(s) need review`
          : undefined,
  };
}
