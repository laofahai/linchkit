/**
 * Link Type schema generation tests
 *
 * Part 1: Drizzle schema generation (FK columns and junction tables)
 * Part 2: GraphQL schema generation (relation fields and bidirectional navigation)
 */

import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  GraphQLList,
  GraphQLNonNull,
  type GraphQLObjectType,
  type GraphQLOutputType,
} from "graphql";
import { generateGraphQLObjectType } from "../../../addons/adapter-server/cap-adapter-server/src/graphql/schema-to-graphql";
import { generateDrizzleTable, generateRelationColumns } from "../src/entity/entity-to-drizzle";
import type { RelationDefinition, EntityDefinition } from "../src/types";

// ── Test fixtures ──────────────────────────────────────────

const departmentSchema: EntityDefinition = {
  name: "department",
  label: "Department",
  fields: {
    name: { type: "string", required: true, label: "Name" },
  },
};

const employeeSchema: EntityDefinition = {
  name: "employee",
  label: "Employee",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    email: { type: "string", unique: true, label: "Email" },
  },
};

const projectSchema: EntityDefinition = {
  name: "project",
  label: "Project",
  fields: {
    title: { type: "string", required: true, label: "Title" },
  },
};

const profileSchema: EntityDefinition = {
  name: "profile",
  label: "Profile",
  fields: {
    bio: { type: "text", label: "Bio" },
  },
};

/** Helper: get column config by name from a table */
function _getColumn(table: ReturnType<typeof generateDrizzleTable>, name: string) {
  const config = getTableConfig(table);
  return config.columns.find((c) => c.name === name);
}

/** Helper: unwrap a GraphQL type to get the named type, stripping NonNull and List wrappers */
function unwrapType(type: GraphQLOutputType): {
  isList: boolean;
  isNonNull: boolean;
  namedType: GraphQLOutputType;
} {
  let isList = false;
  let isNonNull = false;
  let current = type;

  if (current instanceof GraphQLNonNull) {
    isNonNull = true;
    current = current.ofType;
  }
  if (current instanceof GraphQLList) {
    isList = true;
    current = current.ofType;
    if (current instanceof GraphQLNonNull) {
      current = current.ofType;
    }
  }

  return { isList, isNonNull, namedType: current };
}

// ══════════════════════════════════════════════════════════════
// Part 1: Drizzle Schema Generation
// ══════════════════════════════════════════════════════════════

describe("generateRelationColumns", () => {
  // Pre-generate base tables for FK references
  const tables = {
    department: generateDrizzleTable(departmentSchema),
    employee: generateDrizzleTable(employeeSchema),
    project: generateDrizzleTable(projectSchema),
    profile: generateDrizzleTable(profileSchema),
  };

  // ── many_to_one ──────────────────────────────────────────

  describe("many_to_one", () => {
    const link: RelationDefinition = {
      name: "employee_department",
      from: "employee",
      to: "department",
      cardinality: "many_to_one",
    };

    test("generates FK column {to}_id on the 'from' table", () => {
      const result = generateRelationColumns([link], tables);

      // FK column should be on employee table
      expect(result.fkColumns.employee).toBeDefined();
      expect(result.fkColumns.employee.department_id).toBeDefined();

      // No junction tables for many_to_one
      expect(result.junctionTables).toHaveLength(0);
    });

    test("FK column is varchar(128)", () => {
      const result = generateRelationColumns([link], tables);
      const col = result.fkColumns.employee.department_id;

      // Column should be a varchar type (Drizzle column object)
      expect(col).toBeDefined();
    });

    test("does not add FK on the 'to' table", () => {
      const result = generateRelationColumns([link], tables);

      // department table should not get any FK columns
      expect(result.fkColumns.department).toBeUndefined();
    });
  });

  // ── one_to_many ──────────────────────────────────────────

  describe("one_to_many", () => {
    const link: RelationDefinition = {
      name: "department_employees",
      from: "department",
      to: "employee",
      cardinality: "one_to_many",
    };

    test("generates FK column {from}_id on the 'to' table", () => {
      const result = generateRelationColumns([link], tables);

      // FK column should be on employee table (the 'to' side)
      expect(result.fkColumns.employee).toBeDefined();
      expect(result.fkColumns.employee.department_id).toBeDefined();

      // No FK on the 'from' table
      expect(result.fkColumns.department).toBeUndefined();

      // No junction tables
      expect(result.junctionTables).toHaveLength(0);
    });
  });

  // ── one_to_one ──────────────────────────────────────────

  describe("one_to_one", () => {
    const link: RelationDefinition = {
      name: "employee_profile",
      from: "employee",
      to: "profile",
      cardinality: "one_to_one",
    };

    test("generates FK column {to}_id on the 'from' table", () => {
      const result = generateRelationColumns([link], tables);

      expect(result.fkColumns.employee).toBeDefined();
      expect(result.fkColumns.employee.profile_id).toBeDefined();
    });

    test("FK column has unique constraint", () => {
      const result = generateRelationColumns([link], tables);
      // biome-ignore lint/suspicious/noExplicitAny: accessing internal drizzle column config
      const col = result.fkColumns.employee.profile_id as any;

      expect(col).toBeDefined();
      expect(col.config.isUnique).toBe(true);
    });

    test("no junction table created", () => {
      const result = generateRelationColumns([link], tables);
      expect(result.junctionTables).toHaveLength(0);
    });
  });

  // ── many_to_many ──────────────────────────────────────────

  describe("many_to_many", () => {
    const link: RelationDefinition = {
      name: "employee_project",
      from: "employee",
      to: "project",
      cardinality: "many_to_many",
    };

    test("creates a junction table named _link_{name}", () => {
      const result = generateRelationColumns([link], tables);

      expect(result.junctionTables).toHaveLength(1);
      const jt = result.junctionTables[0];
      expect(getTableName(jt)).toBe("_link_employee_project");
    });

    test("junction table has composite PK on both FK columns", () => {
      const result = generateRelationColumns([link], tables);
      const jt = result.junctionTables[0];
      const config = getTableConfig(jt);

      // Should have employee_id and project_id columns
      const employeeIdCol = config.columns.find((c) => c.name === "employee_id");
      const projectIdCol = config.columns.find((c) => c.name === "project_id");
      expect(employeeIdCol).toBeDefined();
      expect(projectIdCol).toBeDefined();

      // Both FK columns should be notNull
      expect(employeeIdCol?.notNull).toBe(true);
      expect(projectIdCol?.notNull).toBe(true);

      // Should have a primary key (composite)
      expect(config.primaryKeys).toHaveLength(1);
    });

    test("does not add FK columns to either from or to table", () => {
      const result = generateRelationColumns([link], tables);

      expect(result.fkColumns.employee).toBeUndefined();
      expect(result.fkColumns.project).toBeUndefined();
    });

    test("junction table has foreign keys referencing both tables", () => {
      const result = generateRelationColumns([link], tables);
      const jt = result.junctionTables[0];
      const config = getTableConfig(jt);

      // Should have 2 foreign keys
      expect(config.foreignKeys).toHaveLength(2);
    });
  });

  // ── M:N properties ──────────────────────────────────────────

  describe("many_to_many with properties", () => {
    const link: RelationDefinition = {
      name: "employee_project_with_role",
      from: "employee",
      to: "project",
      cardinality: "many_to_many",
      properties: {
        role: { type: "string", required: true, label: "Role" },
        joined_at: { type: "datetime", label: "Joined At" },
      },
    };

    test("properties become columns on the junction table", () => {
      const result = generateRelationColumns([link], tables);
      const jt = result.junctionTables[0];
      const config = getTableConfig(jt);

      const roleCol = config.columns.find((c) => c.name === "role");
      expect(roleCol).toBeDefined();
      expect(roleCol?.columnType).toBe("PgVarchar");
      expect(roleCol?.notNull).toBe(true);

      const joinedAtCol = config.columns.find((c) => c.name === "joined_at");
      expect(joinedAtCol).toBeDefined();
      expect(joinedAtCol?.columnType).toBe("PgTimestamp");
    });
  });

  // ── Cascade behavior ──────────────────────────────────────────

  describe("cascade behavior", () => {
    test("cascade: 'delete' sets onDelete cascade on many_to_one FK", () => {
      const link: RelationDefinition = {
        name: "employee_department_cascade",
        from: "employee",
        to: "department",
        cardinality: "many_to_one",
        cascade: "delete",
      };
      const result = generateRelationColumns([link], tables);
      // biome-ignore lint/suspicious/noExplicitAny: accessing internal drizzle column config
      const col = result.fkColumns.employee.department_id as any;
      expect(col).toBeDefined();

      // foreignKeyConfigs stores the FK reference config including onDelete
      expect(col.foreignKeyConfigs).toBeDefined();
      expect(col.foreignKeyConfigs.length).toBeGreaterThan(0);
      expect(col.foreignKeyConfigs[0].actions.onDelete).toBe("cascade");
    });

    test("cascade: 'nullify' sets onDelete set null on many_to_one FK", () => {
      const link: RelationDefinition = {
        name: "employee_department_nullify",
        from: "employee",
        to: "department",
        cardinality: "many_to_one",
        cascade: "nullify",
      };
      const result = generateRelationColumns([link], tables);
      // biome-ignore lint/suspicious/noExplicitAny: accessing internal drizzle column config
      const col = result.fkColumns.employee.department_id as any;
      expect(col).toBeDefined();

      expect(col.foreignKeyConfigs).toBeDefined();
      expect(col.foreignKeyConfigs.length).toBeGreaterThan(0);
      expect(col.foreignKeyConfigs[0].actions.onDelete).toBe("set null");
    });

    test("cascade: 'delete' on one_to_many FK", () => {
      const link: RelationDefinition = {
        name: "dept_emp_cascade",
        from: "department",
        to: "employee",
        cardinality: "one_to_many",
        cascade: "delete",
      };
      const result = generateRelationColumns([link], tables);
      // biome-ignore lint/suspicious/noExplicitAny: accessing internal drizzle column config
      const col = result.fkColumns.employee.department_id as any;
      expect(col).toBeDefined();

      expect(col.foreignKeyConfigs).toBeDefined();
      expect(col.foreignKeyConfigs.length).toBeGreaterThan(0);
      expect(col.foreignKeyConfigs[0].actions.onDelete).toBe("cascade");
    });

    test("cascade: 'delete' on many_to_many junction table FKs", () => {
      const link: RelationDefinition = {
        name: "emp_proj_cascade",
        from: "employee",
        to: "project",
        cardinality: "many_to_many",
        cascade: "delete",
      };
      const result = generateRelationColumns([link], tables);
      const jt = result.junctionTables[0];
      const config = getTableConfig(jt);

      // Both FKs in junction table should have cascade delete
      for (const fk of config.foreignKeys) {
        expect(fk.onDelete).toBe("cascade");
      }
    });
  });

  // ── Table prefix ──────────────────────────────────────────

  describe("table prefix", () => {
    test("FK column table names include prefix", () => {
      const link: RelationDefinition = {
        name: "employee_department",
        from: "employee",
        to: "department",
        cardinality: "many_to_one",
      };
      const result = generateRelationColumns([link], tables, {
        tablePrefix: "app",
      });

      // FK should be keyed by prefixed table name
      expect(result.fkColumns.app_employee).toBeDefined();
      expect(result.fkColumns.app_employee.department_id).toBeDefined();
    });

    test("junction table name includes prefix", () => {
      const link: RelationDefinition = {
        name: "emp_proj",
        from: "employee",
        to: "project",
        cardinality: "many_to_many",
      };
      const result = generateRelationColumns([link], tables, {
        tablePrefix: "app",
      });

      expect(result.junctionTables).toHaveLength(1);
      expect(getTableName(result.junctionTables[0])).toBe("app__link_emp_proj");
    });
  });

  // ── required FK ──────────────────────────────────────────

  test("required: true makes FK column notNull", () => {
    const link: RelationDefinition = {
      name: "employee_department_required",
      from: "employee",
      to: "department",
      cardinality: "many_to_one",
      required: true,
    };
    const result = generateRelationColumns([link], tables);
    // biome-ignore lint/suspicious/noExplicitAny: accessing internal drizzle column config
    const col = result.fkColumns.employee.department_id as any;

    expect(col).toBeDefined();
    expect(col.config.notNull).toBe(true);
  });

  // ── Missing table in tableMap ──────────────────────────────

  test("skips link when referenced table is not in tableMap", () => {
    const link: RelationDefinition = {
      name: "employee_unknown",
      from: "employee",
      to: "nonexistent",
      cardinality: "many_to_one",
    };
    const result = generateRelationColumns([link], tables);

    // Should produce no FK columns and no junction tables
    expect(Object.keys(result.fkColumns)).toHaveLength(0);
    expect(result.junctionTables).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Part 2: GraphQL Schema Generation
// ══════════════════════════════════════════════════════════════

describe("GraphQL link field generation", () => {
  // ── many_to_one ──────────────────────────────────────────

  describe("many_to_one", () => {
    const link: RelationDefinition = {
      name: "employee_department",
      from: "employee",
      to: "department",
      cardinality: "many_to_one",
      label: {
        from: "Department",
        to: "Employees",
      },
    };
    const links = [link];

    // Build typeMap with lazy resolution (GraphQL types reference each other)
    const typeMap = new Map<string, GraphQLObjectType>();
    const employeeType = generateGraphQLObjectType(employeeSchema, undefined, links, typeMap);
    const departmentType = generateGraphQLObjectType(departmentSchema, undefined, links, typeMap);
    typeMap.set("employee", employeeType);
    typeMap.set("department", departmentType);

    test("from-side gets singular object field for the related type", () => {
      const fields = employeeType.getFields();

      // Employee should have a 'department' field (singular)
      expect(fields.department).toBeDefined();

      const { isList, namedType } = unwrapType(fields.department.type);
      expect(isList).toBe(false);
      expect((namedType as GraphQLObjectType).name).toBe("Department");
    });

    test("to-side gets list field for the reverse relation", () => {
      const fields = departmentType.getFields();

      // Department should have an 'employees' field (plural)
      expect(fields.employees).toBeDefined();

      const { isList, namedType } = unwrapType(fields.employees.type);
      expect(isList).toBe(true);
      expect((namedType as GraphQLObjectType).name).toBe("Employee");
    });

    test("field descriptions use link labels", () => {
      const empFields = employeeType.getFields();
      expect(empFields.department.description).toBe("Department");

      const deptFields = departmentType.getFields();
      expect(deptFields.employees.description).toBe("Employees");
    });
  });

  // ── one_to_many ──────────────────────────────────────────

  describe("one_to_many", () => {
    const link: RelationDefinition = {
      name: "department_employees",
      from: "department",
      to: "employee",
      cardinality: "one_to_many",
      label: {
        from: "Employees",
        to: "Department",
      },
    };
    const links = [link];

    const typeMap = new Map<string, GraphQLObjectType>();
    const departmentType = generateGraphQLObjectType(departmentSchema, undefined, links, typeMap);
    const employeeType = generateGraphQLObjectType(employeeSchema, undefined, links, typeMap);
    typeMap.set("department", departmentType);
    typeMap.set("employee", employeeType);

    test("from-side gets list field for the related type", () => {
      const fields = departmentType.getFields();

      // Department (from) should have 'employees' (plural list)
      expect(fields.employees).toBeDefined();

      const { isList, namedType } = unwrapType(fields.employees.type);
      expect(isList).toBe(true);
      expect((namedType as GraphQLObjectType).name).toBe("Employee");
    });

    test("to-side gets singular object field for the reverse relation", () => {
      const fields = employeeType.getFields();

      // Employee (to) should have 'department' (singular)
      expect(fields.department).toBeDefined();

      const { isList, namedType } = unwrapType(fields.department.type);
      expect(isList).toBe(false);
      expect((namedType as GraphQLObjectType).name).toBe("Department");
    });

    test("bidirectional navigation: both sides have resolver fields", () => {
      const deptFields = departmentType.getFields();
      const empFields = employeeType.getFields();

      // Department -> employees (list)
      expect(deptFields.employees).toBeDefined();
      expect(deptFields.employees.resolve).toBeDefined();

      // Employee -> department (singular)
      expect(empFields.department).toBeDefined();
      expect(empFields.department.resolve).toBeDefined();
    });
  });

  // ── one_to_one ──────────────────────────────────────────

  describe("one_to_one", () => {
    const link: RelationDefinition = {
      name: "employee_profile",
      from: "employee",
      to: "profile",
      cardinality: "one_to_one",
    };
    const links = [link];

    const typeMap = new Map<string, GraphQLObjectType>();
    const employeeType = generateGraphQLObjectType(employeeSchema, undefined, links, typeMap);
    const profileType = generateGraphQLObjectType(profileSchema, undefined, links, typeMap);
    typeMap.set("employee", employeeType);
    typeMap.set("profile", profileType);

    test("from-side gets singular object field", () => {
      const fields = employeeType.getFields();

      expect(fields.profile).toBeDefined();

      const { isList, namedType } = unwrapType(fields.profile.type);
      expect(isList).toBe(false);
      expect((namedType as GraphQLObjectType).name).toBe("Profile");
    });

    test("to-side gets singular object field (reverse)", () => {
      const fields = profileType.getFields();

      expect(fields.employee).toBeDefined();

      const { isList, namedType } = unwrapType(fields.employee.type);
      expect(isList).toBe(false);
      expect((namedType as GraphQLObjectType).name).toBe("Employee");
    });
  });

  // ── many_to_many ──────────────────────────────────────────

  describe("many_to_many", () => {
    const link: RelationDefinition = {
      name: "employee_project",
      from: "employee",
      to: "project",
      cardinality: "many_to_many",
    };
    const links = [link];

    const typeMap = new Map<string, GraphQLObjectType>();
    const employeeType = generateGraphQLObjectType(employeeSchema, undefined, links, typeMap);
    const projectType = generateGraphQLObjectType(projectSchema, undefined, links, typeMap);
    typeMap.set("employee", employeeType);
    typeMap.set("project", projectType);

    test("both sides get list fields", () => {
      const empFields = employeeType.getFields();
      const projFields = projectType.getFields();

      // Employee -> projects (plural)
      expect(empFields.projects).toBeDefined();
      const empUnwrapped = unwrapType(empFields.projects.type);
      expect(empUnwrapped.isList).toBe(true);
      expect((empUnwrapped.namedType as GraphQLObjectType).name).toBe("Project");

      // Project -> employees (plural)
      expect(projFields.employees).toBeDefined();
      const projUnwrapped = unwrapType(projFields.employees.type);
      expect(projUnwrapped.isList).toBe(true);
      expect((projUnwrapped.namedType as GraphQLObjectType).name).toBe("Employee");
    });
  });

  // ── Resolver graceful degradation ──────────────────────────

  describe("resolver behavior without dataProvider", () => {
    const link: RelationDefinition = {
      name: "employee_department",
      from: "employee",
      to: "department",
      cardinality: "many_to_one",
    };
    const links = [link];

    const typeMap = new Map<string, GraphQLObjectType>();
    const employeeType = generateGraphQLObjectType(employeeSchema, undefined, links, typeMap);
    const departmentType = generateGraphQLObjectType(departmentSchema, undefined, links, typeMap);
    typeMap.set("employee", employeeType);
    typeMap.set("department", departmentType);

    test("singular resolver returns null when no dataProvider", async () => {
      const fields = employeeType.getFields();
      // biome-ignore lint/style/noNonNullAssertion: resolver is guaranteed to exist
      const resolver = fields.department.resolve!;

      // biome-ignore lint/suspicious/noExplicitAny: mock GraphQL info object
      const result = await resolver({ id: "emp-1", department_id: "dept-1" }, {}, {}, {} as any);
      expect(result).toBeNull();
    });

    test("list resolver returns empty array when no dataProvider", async () => {
      const fields = departmentType.getFields();
      // biome-ignore lint/style/noNonNullAssertion: resolver is guaranteed to exist
      const resolver = fields.employees.resolve!;

      // biome-ignore lint/suspicious/noExplicitAny: mock GraphQL info object
      const result = await resolver({ id: "dept-1" }, {}, {}, {} as any);
      expect(result).toEqual([]);
    });
  });
});
