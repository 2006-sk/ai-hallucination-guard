export interface PackageResult {
  name: string;
  version: string;
  exists: boolean;
  deprecated: boolean;
  latestVersion: string;
  replacement?: string;
  issues: string[];
}

export interface MethodResult {
  file: string;
  line: number;
  packageName: string;
  method: string;
  exists: boolean;
  suggestion?: string;
}

export interface ScanReport {
  packages: PackageResult[];
  methods: MethodResult[];
  summary: {
    total: number;
    hallucinated: number;
    deprecated: number;
    methodIssues: number;
  };
}
