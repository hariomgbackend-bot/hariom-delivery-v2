import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const log = logger("places");

let _client: unknown = null;

async function getPlacesClient() {
  if (_client) return _client;
  const { PlacesClient } = await import("@googlemaps/places");
  if (!config.googleMapsApiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY not configured");
  }
  _client = new PlacesClient({ apiKey: config.googleMapsApiKey });
  return _client as any;
}

// Places API (New) requires an explicit field mask on every call.
// List-style calls (searchText / searchNearby) use `places.` prefixed paths.
const FIELDS_LIST = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.primaryTypeDisplayName",
  "places.location",
].join(",");

// getPlace uses unprefixed paths (the `places/...` resource is the response itself).
const FIELDS_SINGLE = [
  "id",
  "displayName",
  "formattedAddress",
  "rating",
  "userRatingCount",
  "nationalPhoneNumber",
  "websiteUri",
  "primaryTypeDisplayName",
  "location",
  "reviews",
  "regularOpeningHours",
  "businessStatus",
].join(",");

function callOptions(fields: string) {
  return { otherArgs: { headers: { "X-Goog-FieldMask": fields } } };
}

function parseTimestamp(v: any): Date | undefined {
  if (!v) return undefined;
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof v === "object" && v.seconds != null) {
    const d = new Date(Number(v.seconds) * 1000);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  rating?: number;
  totalReviews?: number;
  phone?: string;
  website?: string;
  category?: string;
  latitude?: number;
  longitude?: number;
  openNow?: boolean;
}

export interface PlaceReview {
  author: string;
  authorPhotoUrl?: string;
  rating: number;
  comment: string;
  publishedAt?: Date;
  language?: string;
}

/**
 * Search for a place by text query (e.g., "Hariom Electronics Alandi").
 */
export async function searchPlace(query: string): Promise<PlaceResult | null> {
  try {
    const client = await getPlacesClient();
    const [response] = await client.searchText(
      {
        textQuery: query,
        pageSize: 1,
      },
      callOptions(FIELDS_LIST)
    );

    const place = response.places?.[0];
    if (!place) return null;

    return {
      placeId: place.id || place.name || "",
      name: place.displayName?.text || place.formattedAddress || "",
      address: place.formattedAddress || "",
      rating: place.rating ?? undefined,
      totalReviews: place.userRatingCount ?? undefined,
      phone: place.nationalPhoneNumber || undefined,
      website: place.websiteUri || undefined,
      category: place.primaryTypeDisplayName?.text || undefined,
      latitude: place.location?.latitude ?? undefined,
      longitude: place.location?.longitude ?? undefined,
    };
  } catch (e) {
    log.warn("searchPlace failed", e);
    return null;
  }
}

/**
 * Get detailed place info by place ID.
 */
export async function getPlaceDetails(
  placeId: string
): Promise<PlaceResult | null> {
  try {
    const client = await getPlacesClient();
    const [place] = await client.getPlace(
      {
        name: `places/${placeId}`,
      },
      callOptions(FIELDS_SINGLE)
    );

    if (!place) return null;

    return {
      placeId: place.id || place.name || "",
      name: place.displayName?.text || "",
      address: place.formattedAddress || "",
      rating: place.rating ?? undefined,
      totalReviews: place.userRatingCount ?? undefined,
      phone: place.nationalPhoneNumber || undefined,
      website: place.websiteUri || undefined,
      category: place.primaryTypeDisplayName?.text || undefined,
      latitude: place.location?.latitude ?? undefined,
      longitude: place.location?.longitude ?? undefined,
    };
  } catch (e) {
    log.warn("getPlaceDetails failed", e);
    return null;
  }
}

/**
 * Get up to 5 reviews for a place (Places API only exposes the top 5).
 */
export async function getReviewsFromPlace(placeId: string): Promise<PlaceReview[]> {
  try {
    const client = await getPlacesClient();
    const [place] = await client.getPlace(
      {
        name: `places/${placeId}`,
        languageCode: "en",
      },
      callOptions(FIELDS_SINGLE)
    );

    if (!place?.reviews) return [];

    return place.reviews
      .filter((r: any) => r && typeof r.rating === "number")
      .map((r: any) => ({
        author: r.authorAttribution?.displayName || "Anonymous",
        authorPhotoUrl: r.authorAttribution?.photoUri || undefined,
        rating: r.rating,
        comment: r.text?.text || "",
        publishedAt: parseTimestamp(r.publishTime),
        language: r.languageCode || undefined,
      }));
  } catch (e) {
    log.warn("getReviewsFromPlace failed", e);
    return [];
  }
}

/**
 * Find nearby places by type (e.g., "electronics_store") around a location.
 */
export async function searchNearby(
  latitude: number,
  longitude: number,
  type?: string,
  radius = 1000
): Promise<PlaceResult[]> {
  try {
    const client = await getPlacesClient();
    const [response] = await client.searchNearby(
      {
        locationRestriction: {
          circle: {
            center: { latitude, longitude },
            radius,
          },
        },
        includedTypes: type ? [type] : undefined,
        pageSize: 20,
      },
      callOptions(FIELDS_LIST)
    );

    return (response.places || []).map((p: any) => ({
      placeId: p.id || p.name || "",
      name: p.displayName?.text || "",
      address: p.formattedAddress || "",
      rating: p.rating ?? undefined,
      totalReviews: p.userRatingCount ?? undefined,
      phone: p.nationalPhoneNumber || undefined,
      website: p.websiteUri || undefined,
      category: p.primaryTypeDisplayName?.text || undefined,
      latitude: p.location?.latitude ?? undefined,
      longitude: p.location?.longitude ?? undefined,
    }));
  } catch (e) {
    log.warn("searchNearby failed", e);
    return [];
  }
}

/**
 * Find potential competitors near a location.
 */
export async function findCompetitors(
  latitude: number,
  longitude: number,
  businessName: string,
  types: string[] = ["electronics_store", "store"]
): Promise<PlaceResult[]> {
  const all: PlaceResult[] = [];

  for (const type of types) {
    const nearby = await searchNearby(latitude, longitude, type, 2000);
    const filtered = nearby.filter(
      (p) => !p.name.toLowerCase().includes(businessName.toLowerCase())
    );
    all.push(...filtered);
  }

  const seen = new Set<string>();
  return all.filter((p) => {
    if (seen.has(p.placeId)) return false;
    seen.add(p.placeId);
    return true;
  });
}
