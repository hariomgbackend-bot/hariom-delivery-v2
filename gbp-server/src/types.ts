// ── Google OAuth ──
export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  scope?: string;
  tokenType?: string;
}

export interface GbpAccount {
  uid: string;
  email: string;
  googleAccountId: string;
  accountId?: string;
  tokens?: GoogleTokens;
  linkedAt: Date;
  linkedBy: string;
  syncedAt?: Date;
}

// ── Locations ──
export interface GbpLocation {
  locationId: string;
  accountId: string;
  name: string;
  address: string;
  phone?: string;
  category?: string;
  website?: string;
  rating?: number;
  totalReviews?: number;
  status: string;
  storeId?: string;
  lastSyncedAt?: Date;
  metadata?: Record<string, unknown>;
}

// ── Reviews ──
export interface GbpReview {
  reviewId: string;
  locationId: string;
  author: string;
  authorPhotoUrl?: string;
  rating: number;
  comment: string;
  reply?: string;
  repliedAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
  sentiment?: "positive" | "neutral" | "negative";
  source?: string;
}

export interface ReviewReplyRule {
  ruleId: string;
  locationId: string;
  name: string;
  prompt?: string;
  minRating: number;
  maxRating: number;
  enabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Audit ──
export interface ProfileAudit {
  auditId: string;
  locationId: string;
  score: number;
  dimensions: AuditDimension[];
  suggestions: AuditSuggestion[];
  competitorComparison?: CompetitorComparison;
  ranAt: Date;
}

export interface AuditDimension {
  name: string;
  score: number;
  maxScore: number;
  details: string;
}

export interface AuditSuggestion {
  category: string;
  description: string;
  priority: "low" | "medium" | "high";
  actionUrl?: string;
}

export interface CompetitorComparison {
  totalCompetitors: number;
  avgRating: number;
  avgReviewCount: number;
  topCompetitors: string[];
}

// ── Keywords / Rankings ──
export interface RankEntry {
  position: number;
  keyword: string;
  checkedAt: Date;
  competitorsOnPage?: string[];
}

export interface TrackedKeyword {
  keywordId: string;
  locationId: string;
  keyword: string;
  city?: string;
  currentRank?: number;
  rankHistory: RankEntry[];
  competitorRanks: Record<string, number[]>;
  lastChecked?: Date;
  createdAt: Date;
}

// ── Competitors ──
export interface Competitor {
  compId: string;
  locationId: string;
  placeId: string;
  name: string;
  rating?: number;
  reviewCount?: number;
  category?: string;
  address?: string;
  website?: string;
  phone?: string;
  createdAt: Date;
}

// ── Reports ──
export interface GbpReport {
  reportId: string;
  locationId: string;
  type: "weekly" | "monthly";
  period: string;
  data: ReportData;
  generatedAt: Date;
  status: "generating" | "ready" | "failed";
}

export interface ReportData {
  reviewStats: {
    total: number;
    avgRating: number;
    response: number;
    newReviews: number;
  };
  competitorData?: CompetitorComparison;
  keywordData?: {
    tracked: number;
    avgPosition: number;
    improved: number;
    declined: number;
  };
  auditScore?: number;
}

// ── API Responses ──
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
}

// ── Auth ──
export interface JwtPayload {
  uid: string;
  role: string;
  name?: string;
  storeId?: string;
  isSuperAdmin?: boolean;
}
