import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth.js";
import { getDb } from "../utils/firestore.js";
import { logger } from "../utils/logger.js";
import { syncLocationsToFirestore, getLocationFromStore, saveLocationToStore } from "../services/gbp.js";
import { searchPlace, findCompetitors } from "../services/places.js";
import { ApiResponse, GbpLocation, Competitor } from "../types.js";

const router = Router();
const log = logger("locations");

function pid(p: string | string[] | undefined): string {
  if (Array.isArray(p)) return p[0];
  return p || "";
}

router.get("/locations", authenticate, async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const snap = await db.collection("gbp_locations").get();
    const locations = snap.docs.map((d) => d.data() as GbpLocation);
    res.json({ success: true, data: locations } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * GET /api/gbp/locations/:id
 * Get a single location by ID.
 */
router.get("/locations/:id", authenticate, async (req: Request, res: Response) => {
  try {
    const location = await getLocationFromStore(pid(req.params.id));
    if (!location) {
      res.status(404).json({ success: false, error: "Location not found" } satisfies ApiResponse);
      return;
    }
    res.json({ success: true, data: location } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * POST /api/gbp/locations/sync
 * Force sync locations from GBP API to Firestore.
 * Requires GBP API access approval.
 */
router.post("/locations/sync", authenticate, async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      message: "GBP API sync not available yet. Use search-places to find your business location.",
      data: [],
    } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * POST /api/gbp/locations/search-places
 * Search for a business location using Places API.
 * Works without GBP API approval (just needs Places API key).
 */
router.post("/locations/search-places", authenticate, async (req: Request, res: Response) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== "string") {
      res.status(400).json({ success: false, error: "Missing query" } satisfies ApiResponse);
      return;
    }

    const place = await searchPlace(query);
    if (!place) {
      res.json({ success: true, data: null, message: "No place found" } satisfies ApiResponse);
      return;
    }

    // Auto-save to gbp_locations for future reference
    const location: GbpLocation = {
      locationId: place.placeId,
      accountId: "places-api",
      name: place.name,
      address: place.address,
      phone: place.phone,
      category: place.category,
      rating: place.rating,
      totalReviews: place.totalReviews,
      status: "found-via-places-api",
      lastSyncedAt: new Date(),
      metadata: {
        latitude: place.latitude,
        longitude: place.longitude,
        website: place.website,
        searchQuery: query,
      },
    };
    await saveLocationToStore(location);

    res.json({ success: true, data: place } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * POST /api/gbp/locations/:id/competitors/auto-detect
 * Auto-detect competitors near a location using Places API.
 */
router.post(
  "/locations/:id/competitors/auto-detect",
  authenticate,
  async (req: Request, res: Response) => {
    try {
const location = await getLocationFromStore(pid(req.params.id));
      if (!location?.metadata?.latitude || !location?.metadata?.longitude) {
        res.status(400).json({
          success: false,
          error: "Location has no coordinates.",
        } satisfies ApiResponse);
        return;
      }

      const competitors = await findCompetitors(
        location.metadata.latitude as number,
        location.metadata.longitude as number,
        location.name
      );

      const db = getDb();
      const batch = db.batch();
      const col = db.collection("gbp_competitors");

      for (const comp of competitors) {
        const docId = `${location.locationId}_${comp.placeId}`;
        const docData: Competitor = {
          compId: docId,
          locationId: location.locationId,
          placeId: comp.placeId,
          name: comp.name,
          rating: comp.rating,
          reviewCount: comp.totalReviews,
          category: comp.category,
          address: comp.address,
          website: comp.website,
          phone: comp.phone,
          createdAt: new Date(),
        };
        batch.set(col.doc(docId), docData, { merge: true });
      }

      await batch.commit();

      res.json({
        success: true,
        data: competitors,
        message: `Found ${competitors.length} competitors`,
      } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

/**
 * GET /api/gbp/locations/:id/competitors
 * List stored competitors for a location.
 */
router.get(
  "/locations/:id/competitors",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const snap = await db
        .collection("gbp_competitors")
        .where("locationId", "==", pid(req.params.id))
        .get();

      const competitors = snap.docs.map((d) => d.data() as Competitor);
      res.json({ success: true, data: competitors } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

export default router;
