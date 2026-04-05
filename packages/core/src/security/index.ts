// Note: tenant-isolation.ts is exported only from server-entry.ts
// because it depends on server-side DataProvider types.
export {
  canUnmask,
  type MaskRecordOptions,
  maskRecord,
  maskRecords,
  maskValue,
  resolveFieldMasking,
} from "./masking-engine";
