import { beforeEach, describe, expect, it } from "bun:test";
import type { RelationRegistry } from "@linchkit/core";
import { createRelationRegistry, defineRelation } from "@linchkit/core";

// ── Test fixtures ──────────────────────────────────────────

const employeeDepartmentLink = defineRelation({
  name: "employee_department",
  from: "employee",
  to: "department",
  cardinality: "many_to_one",
  fromName: "department",
  toName: "employees",
  label: {
    from: "Department",
    to: "Employees",
  },
});

const orderCustomerLink = defineRelation({
  name: "order_customer",
  from: "order",
  to: "customer",
  cardinality: "many_to_one",
  fromName: "customer",
  toName: "orders",
  label: {
    from: "Customer",
    to: "Orders",
  },
  cascade: "nullify",
});

const userProfileLink = defineRelation({
  name: "user_profile",
  from: "user",
  to: "profile",
  cardinality: "one_to_one",
  fromName: "profile",
  toName: "user",
  label: {
    from: "Profile",
    to: "User",
  },
  required: true,
});

const departmentProjectsLink = defineRelation({
  name: "department_projects",
  from: "department",
  to: "project",
  cardinality: "one_to_many",
  fromName: "projects",
  toName: "department",
  label: {
    from: "Projects",
    to: "Department",
  },
});

const studentCourseLink = defineRelation({
  name: "student_course",
  from: "student",
  to: "course",
  cardinality: "many_to_many",
  fromName: "courses",
  toName: "students",
  label: {
    from: "Courses",
    to: "Students",
  },
  properties: {
    enrolled_at: { type: "datetime" },
    grade: { type: "text" },
  },
});

// ── Tests ──────────────────────────────────────────────────

describe("RelationRegistry", () => {
  let registry: RelationRegistry;

  beforeEach(() => {
    registry = createRelationRegistry();
  });

  // ── register() ───────────────────────────────────────────

  describe("register()", () => {
    it("registers a link definition", () => {
      registry.register(employeeDepartmentLink);
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0]).toBe(employeeDepartmentLink);
    });

    it("registers multiple links", () => {
      registry.register(employeeDepartmentLink);
      registry.register(orderCustomerLink);
      registry.register(userProfileLink);
      expect(registry.list()).toHaveLength(3);
    });

    it("throws on duplicate link name", () => {
      registry.register(employeeDepartmentLink);
      expect(() => registry.register(employeeDepartmentLink)).toThrow(
        'Relation "employee_department" is already registered',
      );
    });

    it("throws on duplicate name even with different endpoints", () => {
      registry.register(employeeDepartmentLink);
      const duplicate = defineRelation({
        name: "employee_department",
        from: "other_schema",
        to: "another_schema",
        cardinality: "one_to_one",
        fromName: "another",
        toName: "other",
      });
      expect(() => registry.register(duplicate)).toThrow(
        'Relation "employee_department" is already registered',
      );
    });
  });

  // ── relationsFor() ───────────────────────────────────────────

  describe("relationsFor()", () => {
    beforeEach(() => {
      registry.register(employeeDepartmentLink);
      registry.register(departmentProjectsLink);
      registry.register(orderCustomerLink);
    });

    it("returns outgoing links with correct direction", () => {
      const links = registry.relationsFor("employee");
      expect(links).toHaveLength(1);
      expect(links[0].direction).toBe("outgoing");
      expect(links[0].relatedEntity).toBe("department");
      expect(links[0].label).toBe("Department");
      expect(links[0].relation).toBe(employeeDepartmentLink);
    });

    it("returns incoming links with correct direction", () => {
      const links = registry.relationsFor("department");
      // department has: incoming from employee, outgoing to project
      expect(links).toHaveLength(2);

      const incoming = links.find((l) => l.direction === "incoming");
      expect(incoming).toBeDefined();
      expect(incoming?.relatedEntity).toBe("employee");
      expect(incoming?.label).toBe("Employees");

      const outgoing = links.find((l) => l.direction === "outgoing");
      expect(outgoing).toBeDefined();
      expect(outgoing?.relatedEntity).toBe("project");
      expect(outgoing?.label).toBe("Projects");
    });

    it("returns empty array for unknown schema", () => {
      expect(registry.relationsFor("nonexistent")).toEqual([]);
    });

    it("uses schema name as fallback label when label is not set", () => {
      const noLabelLink = defineRelation({
        name: "task_project",
        from: "task",
        to: "project",
        cardinality: "many_to_one",
        fromName: "project",
        toName: "tasks",
      });
      registry.register(noLabelLink);

      const taskLinks = registry.relationsFor("task");
      expect(taskLinks[0].label).toBe("project"); // falls back to fromName

      const projectLinks = registry.relationsFor("project");
      const incoming = projectLinks.find((l) => l.relation.name === "task_project");
      expect(incoming?.label).toBe("tasks"); // falls back to toName
    });

    it("returns both directions for self-referencing link", () => {
      const selfLink = defineRelation({
        name: "employee_manager",
        from: "employee",
        to: "employee",
        cardinality: "many_to_one",
        fromName: "manager",
        toName: "direct_reports",
        label: {
          from: "Manager",
          to: "Direct Reports",
        },
      });
      registry.register(selfLink);

      const links = registry.relationsFor("employee");
      // employee already has 1 outgoing (to department) + 2 from self-link (outgoing + incoming)
      const selfLinks = links.filter((l) => l.relation.name === "employee_manager");
      expect(selfLinks).toHaveLength(2);
      expect(selfLinks.find((l) => l.direction === "outgoing")?.label).toBe("Manager");
      expect(selfLinks.find((l) => l.direction === "incoming")?.label).toBe("Direct Reports");
    });
  });

  // ── relationBetween() ────────────────────────────────────────

  describe("relationsBetween()", () => {
    beforeEach(() => {
      registry.register(employeeDepartmentLink);
      registry.register(orderCustomerLink);
    });

    it("finds links by from and to endpoints", () => {
      const result = registry.relationsBetween("employee", "department");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(employeeDepartmentLink);
    });

    it("returns empty array when no link matches", () => {
      expect(registry.relationsBetween("employee", "customer")).toEqual([]);
    });

    it("is directional — reversed endpoints return empty array", () => {
      expect(registry.relationsBetween("department", "employee")).toEqual([]);
    });

    it("returns empty array for unknown schemas", () => {
      expect(registry.relationsBetween("nonexistent", "department")).toEqual([]);
    });
  });

  // ── outgoingLinks() ──────────────────────────────────────

  describe("outgoingLinks()", () => {
    beforeEach(() => {
      registry.register(employeeDepartmentLink);
      registry.register(departmentProjectsLink);
      registry.register(orderCustomerLink);
    });

    it("returns only outgoing links", () => {
      const links = registry.outgoingRelations("department");
      expect(links).toHaveLength(1);
      expect(links[0]).toBe(departmentProjectsLink);
    });

    it("returns empty for schema with only incoming links", () => {
      const links = registry.outgoingRelations("project");
      expect(links).toHaveLength(0);
    });

    it("returns empty for unknown schema", () => {
      expect(registry.outgoingRelations("nonexistent")).toEqual([]);
    });
  });

  // ── incomingLinks() ──────────────────────────────────────

  describe("incomingLinks()", () => {
    beforeEach(() => {
      registry.register(employeeDepartmentLink);
      registry.register(departmentProjectsLink);
      registry.register(orderCustomerLink);
    });

    it("returns only incoming links", () => {
      const links = registry.incomingRelations("department");
      expect(links).toHaveLength(1);
      expect(links[0]).toBe(employeeDepartmentLink);
    });

    it("returns empty for schema with only outgoing links", () => {
      const links = registry.incomingRelations("employee");
      expect(links).toHaveLength(0);
    });

    it("returns empty for unknown schema", () => {
      expect(registry.incomingRelations("nonexistent")).toEqual([]);
    });
  });

  // ── list() ───────────────────────────────────────────────

  describe("list()", () => {
    it("returns empty array when no links registered", () => {
      expect(registry.list()).toEqual([]);
    });

    it("returns all registered links", () => {
      registry.register(employeeDepartmentLink);
      registry.register(orderCustomerLink);
      registry.register(userProfileLink);

      const all = registry.list();
      expect(all).toHaveLength(3);
      expect(all).toContain(employeeDepartmentLink);
      expect(all).toContain(orderCustomerLink);
      expect(all).toContain(userProfileLink);
    });
  });

  // ── Cardinalities ────────────────────────────────────────

  describe("cardinalities", () => {
    it("handles one_to_one", () => {
      registry.register(userProfileLink);
      const links = registry.relationsBetween("user", "profile");
      expect(links).toHaveLength(1);
      expect(links[0]?.cardinality).toBe("one_to_one");
      expect(links[0]?.required).toBe(true);
    });

    it("handles one_to_many", () => {
      registry.register(departmentProjectsLink);
      const links = registry.relationsBetween("department", "project");
      expect(links[0]?.cardinality).toBe("one_to_many");
    });

    it("handles many_to_one", () => {
      registry.register(employeeDepartmentLink);
      const links = registry.relationsBetween("employee", "department");
      expect(links[0]?.cardinality).toBe("many_to_one");
    });

    it("handles many_to_many", () => {
      registry.register(studentCourseLink);
      const links = registry.relationsBetween("student", "course");
      expect(links[0]?.cardinality).toBe("many_to_many");
    });
  });

  // ── Links with properties (M:N junction fields) ──────────

  describe("links with properties", () => {
    it("stores junction table properties on many_to_many links", () => {
      registry.register(studentCourseLink);
      const links = registry.relationsBetween("student", "course");
      expect(links[0]?.properties).toBeDefined();
      expect(links[0]?.properties?.enrolled_at).toEqual({ type: "datetime" });
      expect(links[0]?.properties?.grade).toEqual({ type: "text" });
    });

    it("links without properties have undefined properties field", () => {
      registry.register(employeeDepartmentLink);
      const links = registry.relationsBetween("employee", "department");
      expect(links[0]?.properties).toBeUndefined();
    });

    it("many_to_many properties are visible via relationsFor()", () => {
      registry.register(studentCourseLink);
      const links = registry.relationsFor("student");
      expect(links[0].relation.properties).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: checked above with toBeDefined
      expect(Object.keys(links[0].relation.properties!)).toEqual(["enrolled_at", "grade"]);
    });
  });

  // ── relationByName() ─────────────────────────────────────────

  describe("relationByName()", () => {
    beforeEach(() => {
      registry.register(employeeDepartmentLink);
      registry.register(departmentProjectsLink);
      registry.register(orderCustomerLink);
    });

    it("finds outgoing relation by fromName", () => {
      const info = registry.relationByName("employee", "department");
      expect(info).not.toBeNull();
      expect(info?.direction).toBe("outgoing");
      expect(info?.relatedEntity).toBe("department");
      expect(info?.semanticName).toBe("department");
      expect(info?.relation).toBe(employeeDepartmentLink);
    });

    it("finds incoming relation by toName", () => {
      const info = registry.relationByName("department", "employees");
      expect(info).not.toBeNull();
      expect(info?.direction).toBe("incoming");
      expect(info?.relatedEntity).toBe("employee");
      expect(info?.semanticName).toBe("employees");
      expect(info?.relation).toBe(employeeDepartmentLink);
    });

    it("returns null for unknown semantic name", () => {
      expect(registry.relationByName("employee", "nonexistent")).toBeNull();
    });

    it("returns null for unknown entity", () => {
      expect(registry.relationByName("nonexistent", "department")).toBeNull();
    });

    it("uses label when available, falls back to semantic name", () => {
      const withLabel = registry.relationByName("employee", "department");
      expect(withLabel?.label).toBe("Department");

      const noLabelLink = defineRelation({
        name: "task_project",
        from: "task",
        to: "project",
        cardinality: "many_to_one",
        fromName: "project",
        toName: "tasks",
      });
      registry.register(noLabelLink);
      const noLabel = registry.relationByName("task", "project");
      expect(noLabel?.label).toBe("project"); // falls back to fromName
    });
  });

  // ── Semantic name validation ────────────────────────────────

  describe("semantic name validation", () => {
    it("rejects empty fromName", () => {
      expect(() =>
        registry.register(
          defineRelation({
            name: "bad_from",
            from: "a",
            to: "b",
            cardinality: "one_to_one",
            fromName: "",
            toName: "a_items",
          }),
        ),
      ).toThrow('Relation "bad_from" missing fromName');
    });

    it("rejects empty toName", () => {
      expect(() =>
        registry.register(
          defineRelation({
            name: "bad_to",
            from: "a",
            to: "b",
            cardinality: "one_to_one",
            fromName: "b_item",
            toName: "",
          }),
        ),
      ).toThrow('Relation "bad_to" missing toName');
    });

    it("rejects fromName with uppercase letters", () => {
      expect(() =>
        registry.register(
          defineRelation({
            name: "bad_case",
            from: "a",
            to: "b",
            cardinality: "one_to_one",
            fromName: "MyDepartment",
            toName: "items",
          }),
        ),
      ).toThrow("is not a valid identifier (must be snake_case)");
    });

    it("rejects toName with spaces", () => {
      expect(() =>
        registry.register(
          defineRelation({
            name: "bad_space",
            from: "a",
            to: "b",
            cardinality: "one_to_one",
            fromName: "department",
            toName: "my items",
          }),
        ),
      ).toThrow("is not a valid identifier (must be snake_case)");
    });

    it("rejects fromName starting with a digit", () => {
      expect(() =>
        registry.register(
          defineRelation({
            name: "bad_digit",
            from: "a",
            to: "b",
            cardinality: "one_to_one",
            fromName: "1department",
            toName: "items",
          }),
        ),
      ).toThrow("is not a valid identifier (must be snake_case)");
    });

    it("rejects names with hyphens", () => {
      expect(() =>
        registry.register(
          defineRelation({
            name: "bad_hyphen",
            from: "a",
            to: "b",
            cardinality: "one_to_one",
            fromName: "my-department",
            toName: "items",
          }),
        ),
      ).toThrow("is not a valid identifier (must be snake_case)");
    });

    it("accepts valid snake_case names", () => {
      expect(() =>
        registry.register(
          defineRelation({
            name: "valid_relation",
            from: "a",
            to: "b",
            cardinality: "one_to_one",
            fromName: "b_item",
            toName: "a_item",
          }),
        ),
      ).not.toThrow();
    });

    it("accepts single-word names", () => {
      expect(() =>
        registry.register(
          defineRelation({
            name: "single_word",
            from: "x",
            to: "y",
            cardinality: "one_to_one",
            fromName: "target",
            toName: "source",
          }),
        ),
      ).not.toThrow();
    });
  });

  // ── Duplicate semantic name detection ────────────────────────

  describe("duplicate semantic name detection", () => {
    it("rejects duplicate fromName on same from-entity", () => {
      registry.register(
        defineRelation({
          name: "person_authored_doc",
          from: "person",
          to: "document",
          cardinality: "many_to_many",
          fromName: "documents",
          toName: "authors",
        }),
      );
      expect(() =>
        registry.register(
          defineRelation({
            name: "person_reviewed_doc",
            from: "person",
            to: "document",
            cardinality: "many_to_many",
            fromName: "documents", // duplicate on person
            toName: "reviewers",
          }),
        ),
      ).toThrow('Entity "person" has duplicate semantic name "documents"');
    });

    it("rejects duplicate toName on same to-entity", () => {
      registry.register(
        defineRelation({
          name: "employee_dept",
          from: "employee",
          to: "department",
          cardinality: "many_to_one",
          fromName: "department",
          toName: "staff",
        }),
      );
      expect(() =>
        registry.register(
          defineRelation({
            name: "contractor_dept",
            from: "contractor",
            to: "department",
            cardinality: "many_to_one",
            fromName: "department",
            toName: "staff", // duplicate toName on department
          }),
        ),
      ).toThrow('Entity "department" has duplicate semantic name "staff"');
    });

    it("rejects cross-direction semantic name conflict", () => {
      registry.register(
        defineRelation({
          name: "dept_employees",
          from: "department",
          to: "employee",
          cardinality: "one_to_many",
          fromName: "employees",
          toName: "department",
        }),
      );
      // A new relation where fromName on employee conflicts with toName from above
      expect(() =>
        registry.register(
          defineRelation({
            name: "employee_manager",
            from: "employee",
            to: "manager",
            cardinality: "many_to_one",
            fromName: "department", // conflicts with toName "department" on employee
            toName: "subordinates",
          }),
        ),
      ).toThrow('Entity "employee" has duplicate semantic name "department"');
    });

    it("allows same semantic name on different entities", () => {
      registry.register(
        defineRelation({
          name: "order_dept",
          from: "order",
          to: "department",
          cardinality: "many_to_one",
          fromName: "department",
          toName: "orders",
        }),
      );
      // "department" as fromName on a different entity is fine
      expect(() =>
        registry.register(
          defineRelation({
            name: "employee_dept",
            from: "employee",
            to: "department",
            cardinality: "many_to_one",
            fromName: "department",
            toName: "employees",
          }),
        ),
      ).not.toThrow();
    });
  });

  // ── Multiple relations between same entities ──────────────────

  describe("multiple relations between same entities", () => {
    it("allows multiple relations between same entity pair with different names", () => {
      registry.register(
        defineRelation({
          name: "person_authored_doc",
          from: "person",
          to: "document",
          cardinality: "many_to_many",
          fromName: "authored_documents",
          toName: "authors",
        }),
      );
      registry.register(
        defineRelation({
          name: "person_reviewed_doc",
          from: "person",
          to: "document",
          cardinality: "many_to_many",
          fromName: "reviewed_documents",
          toName: "reviewers",
        }),
      );

      const between = registry.relationsBetween("person", "document");
      expect(between).toHaveLength(2);

      const personRelations = registry.relationsFor("person");
      const outgoing = personRelations.filter((r) => r.direction === "outgoing");
      expect(outgoing).toHaveLength(2);
      expect(outgoing.map((r) => r.semanticName).sort()).toEqual([
        "authored_documents",
        "reviewed_documents",
      ]);

      const docRelations = registry.relationsFor("document");
      const incoming = docRelations.filter((r) => r.direction === "incoming");
      expect(incoming).toHaveLength(2);
      expect(incoming.map((r) => r.semanticName).sort()).toEqual(["authors", "reviewers"]);
    });

    it("relationByName disambiguates multiple relations between same pair", () => {
      registry.register(
        defineRelation({
          name: "person_authored_doc",
          from: "person",
          to: "document",
          cardinality: "many_to_many",
          fromName: "authored_documents",
          toName: "authors",
        }),
      );
      registry.register(
        defineRelation({
          name: "person_reviewed_doc",
          from: "person",
          to: "document",
          cardinality: "many_to_many",
          fromName: "reviewed_documents",
          toName: "reviewers",
        }),
      );

      const authored = registry.relationByName("person", "authored_documents");
      expect(authored?.relation.name).toBe("person_authored_doc");

      const reviewed = registry.relationByName("person", "reviewed_documents");
      expect(reviewed?.relation.name).toBe("person_reviewed_doc");

      const authors = registry.relationByName("document", "authors");
      expect(authors?.relation.name).toBe("person_authored_doc");

      const reviewers = registry.relationByName("document", "reviewers");
      expect(reviewers?.relation.name).toBe("person_reviewed_doc");
    });
  });

  // ── Cascade and optional fields ──────────────────────────

  describe("optional fields", () => {
    it("stores cascade behavior", () => {
      registry.register(orderCustomerLink);
      const links = registry.relationsBetween("order", "customer");
      expect(links[0]?.cascade).toBe("nullify");
    });

    it("cascade defaults to undefined when not set", () => {
      registry.register(employeeDepartmentLink);
      const links = registry.relationsBetween("employee", "department");
      expect(links[0]?.cascade).toBeUndefined();
    });

    it("stores description field", () => {
      const described = defineRelation({
        name: "described_link",
        from: "a",
        to: "b",
        cardinality: "one_to_one",
        fromName: "b_item",
        toName: "a_item",
        description: "A test link with description",
      });
      registry.register(described);
      expect(registry.list()[0].description).toBe("A test link with description");
    });
  });
});
