// Note: tenant-isolation.ts is exported only from server-entry.ts
// because it depends on server-side DataProvider types.
export {
  canUnmask,
  maskRecord,
  maskRecords,
  maskValue,
  resolveFieldMasking,
  type MaskRecordOptions,
} from "./masking-engine";
