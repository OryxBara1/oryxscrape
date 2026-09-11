// Non-sensitive Google Shared Drive configuration for the OryxScrape ↔ AuraMaris exchange.
// These are IDs only — no credentials. Credentials come from the linked Drive connector.

export const EXCHANGE_SHARED_DRIVE_ID = "0AOesw6uCeLquUk9PVA";

export const EXCHANGE_FOLDERS = {
  pendingReview: "1mTL8uCeCeVk7ea1M_mW3Zy1-i3gNalbi", // 01_Pending_Review  (OryxScrape writes)
  accepted: "1neUSalxkeJ27AP_pyg5R0VZN8PcmQLiv", // 02_Accepted        (AuraMaris only — never written by us)
  rejected: "19cl6vEescHgSui8tYk50B5WP6HFd_zgu", // 03_Rejected        (AuraMaris only — never written by us)
  rejectionFeedback: "1JXhXcBtZPYEAbOSp3j1nXdNjqLfEAbyJ", // 04_Rejection_Feedback (we read feedback, write acks)
  searchTermsShared: "1vkY03W1TWkAsDYIvAYLte3BKz79Ft3Qk", // 05_Search_Terms_Shared (we write exports)
} as const;

// Folders this identity is allowed to write to. 02/03 are deliberately excluded.
export const WRITABLE_FOLDER_IDS: readonly string[] = [
  EXCHANGE_FOLDERS.pendingReview,
  EXCHANGE_FOLDERS.rejectionFeedback,
  EXCHANGE_FOLDERS.searchTermsShared,
];

export const ARTIFACT_KIND = "extracted_text_only";
export const CONTENT_INTEGRITY_SCOPE = "normalized_extracted_text";
export const MANIFEST_VERSION = "1.0";
