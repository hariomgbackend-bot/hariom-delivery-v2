# Project Audit Report: Hariom Delivery Management System (DMS)

**Date:** Saturday, June 13, 2026
**Auditor:** Gemini CLI
**Scope:** Folder-level audit for Redundant Code, Dead Code, and Room for Improvement.

---

### 1. Dead Code (Unused / Obsolete Files)
The following files are identified as development leftovers, one-time scripts, or temporary logs. These should be removed to clean up the workspace.

| File Path | Description | Recommended Action |
| :--- | :--- | :--- |
| `audit_script.js` | Legacy logic for auditing. | Delete |
| `audit_scripts.js` | Duplicate/variation of audit script. | Delete |
| `audit.log` | Temporary log file. | Delete / Add to `.gitignore` |
| `audit_results.txt` | Temporary results file. | Delete |
| `check_ids.js` | Debugging script for ID verification. | Delete |
| `scanner_test.html` | Frontend test for scanner functionality. | Move to `tests/` or Delete |
| `tally-test.html` | Frontend test for Tally integration. | Move to `tests/` or Delete |
| `tally_debug.html` | Debugging view for Tally XML. | Move to `tests/` or Delete |
| `test_api.js` | Manual API testing script. | Move to `tests/` or Delete |
| `tmp_script.js` | Temporary script (67KB, large). | Delete |
| `legacy_import.html` | One-time import interface. | Delete |
| `migrate_service_tickets.js`| One-time migration script. | Delete |

---

### 2. Redundant Code (Duplicates & Misplaced Files)
The project contains several files that are duplicates of root files or contain duplicated logic.

#### A. Misplaced/Duplicate HTML & JS
The `icons/` folder contains several files that do not belong there and appear to be old versions of root files:
*   `icons/accountant.html` (Duplicate of root `accountant.html`)
*   `icons/admin.html` (Duplicate of root `admin.html`)
*   `icons/server.js` (Old version of `server.js`)

**Action:** Delete `icons/accountant.html`, `icons/admin.html`, and `icons/server.js`.

#### B. Configuration Redundancy
*   **Firebase Initialization:** `firebase.js`, `firestore.js`, and `storage.js` all contain separate initialization logic for Firebase.
    *   *Correction:* Consolidate into a single `firebase.js` that exports `db` and `storage`.
*   **Manifest Files:** `manifest.json`, `staff-manifest.json`, and `driver-manifest.json` share many similarities.
    *   *Correction:* Use a dynamic manifest generator or a shared template if possible.

---

### 3. Room for Improvement (Technical Debt & Best Practices)

#### A. Architectural Improvements
*   **Monolithic `server.js`:** At **4,408 lines**, the main server file is a major maintenance risk.
    *   *Recommendation:* Modularize into `routes/`, `controllers/`, and `services/`.
*   **Asset Externalization:** Files like `driver_interface.html` and `staff.html` are massive (100KB - 300KB) due to inline CSS and JavaScript.
    *   *Recommendation:* Extract CSS to `.css` files and JS to `.js` files to enable browser caching and improve readability.

#### B. Performance & Scalability
*   **Pagination:** Many endpoints return entire collections from Firestore. This will lead to performance degradation as the database grows.
    *   *Recommendation:* Implement `limit` and `startAfter` (cursor-based pagination) for all list endpoints.
*   **Database Indexes:** Frequently queried fields like `status` and `assigned_driver_id` lack composite indexes in Firestore.
    *   *Recommendation:* Create the necessary composite indexes in the Firebase Console.

#### C. Security
*   **Credential Management:** The Firebase Service Account is loaded from a JSON file (`firebase-service-account.json`).
    *   *Recommendation:* Store sensitive credentials in environment variables (e.g., `FIREBASE_SERVICE_ACCOUNT` as a base64 string or JSON string) and load them via `process.env`.
*   **Input Sanitization:** While `sanitizeRequest` middleware is present, ensure it covers all edge cases, especially for nested objects in XML imports.

#### D. Maintenance & Quality
*   **TypeScript Migration:** Transitioning to TypeScript would greatly reduce runtime errors, especially when handling complex data structures from Tally.
*   **Automated Testing:** Replace manual test scripts (`test_api.js`) with a proper testing framework like Vitest or Jest.

---

### 4. Immediate Next Steps
1.  **Cleanup:** Execute a cleanup of the `icons/` folder and the root "Dead Code" files.
2.  **Refactor:** Begin splitting `server.js` into smaller, domain-specific route files (e.g., `routes/deliveries.js`).
3.  **Optimize:** Extract large JS blocks from `driver_interface.html` to improve load times.
