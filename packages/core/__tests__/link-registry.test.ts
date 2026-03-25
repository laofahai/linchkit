import { beforeEach, describe, expect, it } from "bun:test";
import type { LinkRegistry } from "@linchkit/core";
import { createLinkRegistry, defineLink } from "@linchkit/core";

// ── Test fixtures ──────────────────────────────────────────

const employeeDepartmentLink = defineLink({
  name: "employee_department",
  from: "employee",
  to: "department",
  cardinality: "many_to_one",
  label: {
    from: "Department",
    to: "Employees",
  },
});

const orderCustomerLink = defineLink({
  name: "order_customer",
  from: "order",
  to: "customer",
  cardinality: "many_to_one",
  label: {
    from: "Customer",
    to: "Orders",
  },
  cascade: "nullify",
});

const userProfileLink = defineLink({
  name: "user_profile",
  from: "user",
  to: "profile",
  cardinality: "one_to_one",
  label: {
    from: "Profile",
    to: "User",
  },
  required: true,
});

const departmentProjectsLink = defineLink({
  name: "department_projects",
  from: "department",
  to: "project",
  cardinality: "one_to_many",
  label: {
    from: "Projects",
    to: "Department",
  },
});

const studentCourseLink = defineLink({
  name: "student_course",
  from: "student",
  to: "course",
  cardinality: "many_to_many",
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

describe("LinkRegistry", () => {
  let registry: LinkRegistry;

  beforeEach(() => {
    registry = createLinkRegistry();
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
        'Link "employee_department" is already registered',
      );
    });

    it("throws on duplicate name even with different endpoints", () => {
      registry.register(employeeDepartmentLink);
      const duplicate = defineLink({
        name: "employee_department",
        from: "other_schema",
        to: "another_schema",
        cardinality: "one_to_one",
      });
      expect(() => registry.register(duplicate)).toThrow(
        'Link "employee_department" is already registered',
      );
    });
  });

  // ── linksFor() ───────────────────────────────────────────

  describe("linksFor()", () => {
    beforeEach(() => {
      registry.register(employeeDepartmentLink);
      registry.register(departmentProjectsLink);
      registry.register(orderCustomerLink);
    });

    it("returns outgoing links with correct direction", () => {
      const links = registry.linksFor("employee");
      expect(links).toHaveLength(1);
      expect(links[0].direction).toBe("outgoing");
      expect(links[0].relatedSchema).toBe("department");
      expect(links[0].label).toBe("Department");
      expect(links[0].link).toBe(employeeDepartmentLink);
    });

    it("returns incoming links with correct direction", () => {
      const links = registry.linksFor("department");
      // department has: incoming from employee, outgoing to project
      expect(links).toHaveLength(2);

      const incoming = links.find((l) => l.direction === "incoming");
      expect(incoming).toBeDefined();
      expect(incoming?.relatedSchema).toBe("employee");
      expect(incoming?.label).toBe("Employees");

      const outgoing = links.find((l) => l.direction === "outgoing");
      expect(outgoing).toBeDefined();
      expect(outgoing?.relatedSchema).toBe("project");
      expect(outgoing?.label).toBe("Projects");
    });

    it("returns empty array for unknown schema", () => {
      expect(registry.linksFor("nonexistent")).toEqual([]);
    });

    it("uses schema name as fallback label when label is not set", () => {
      const noLabelLink = defineLink({
        name: "task_project",
        from: "task",
        to: "project",
        cardinality: "many_to_one",
      });
      registry.register(noLabelLink);

      const taskLinks = registry.linksFor("task");
      expect(taskLinks[0].label).toBe("project"); // falls back to `to` schema name

      const projectLinks = registry.linksFor("project");
      const incoming = projectLinks.find((l) => l.link.name === "task_project");
      expect(incoming?.label).toBe("task"); // falls back to `from` schema name
    });

    it("returns both directions for self-referencing link", () => {
      const selfLink = defineLink({
        name: "employee_manager",
        from: "employee",
        to: "employee",
        cardinality: "many_to_one",
        label: {
          from: "Manager",
          to: "Direct Reports",
        },
      });
      registry.register(selfLink);

      const links = registry.linksFor("employee");
      // employee already has 1 outgoing (to department) + 2 from self-link (outgoing + incoming)
      const selfLinks = links.filter((l) => l.link.name === "employee_manager");
      expect(selfLinks).toHaveLength(2);
      expect(selfLinks.find((l) => l.direction === "outgoing")?.label).toBe("Manager");
      expect(selfLinks.find((l) => l.direction === "incoming")?.label).toBe("Direct Reports");
    });
  });

  // ── linkBetween() ────────────────────────────────────────

  describe("linkBetween()", () => {
    beforeEach(() => {
      registry.register(employeeDepartmentLink);
      registry.register(orderCustomerLink);
    });

    it("finds a link by from and to endpoints", () => {
      const result = registry.linkBetween("employee", "department");
      expect(result).toBe(employeeDepartmentLink);
    });

    it("returns null when no link matches", () => {
      expect(registry.linkBetween("employee", "customer")).toBeNull();
    });

    it("is directional — reversed endpoints return null", () => {
      expect(registry.linkBetween("department", "employee")).toBeNull();
    });

    it("returns null for unknown schemas", () => {
      expect(registry.linkBetween("nonexistent", "department")).toBeNull();
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
      const links = registry.outgoingLinks("department");
      expect(links).toHaveLength(1);
      expect(links[0]).toBe(departmentProjectsLink);
    });

    it("returns empty for schema with only incoming links", () => {
      const links = registry.outgoingLinks("project");
      expect(links).toHaveLength(0);
    });

    it("returns empty for unknown schema", () => {
      expect(registry.outgoingLinks("nonexistent")).toEqual([]);
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
      const links = registry.incomingLinks("department");
      expect(links).toHaveLength(1);
      expect(links[0]).toBe(employeeDepartmentLink);
    });

    it("returns empty for schema with only outgoing links", () => {
      const links = registry.incomingLinks("employee");
      expect(links).toHaveLength(0);
    });

    it("returns empty for unknown schema", () => {
      expect(registry.incomingLinks("nonexistent")).toEqual([]);
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
      const link = registry.linkBetween("user", "profile");
      expect(link).not.toBeNull();
      expect(link?.cardinality).toBe("one_to_one");
      expect(link?.required).toBe(true);
    });

    it("handles one_to_many", () => {
      registry.register(departmentProjectsLink);
      const link = registry.linkBetween("department", "project");
      expect(link?.cardinality).toBe("one_to_many");
    });

    it("handles many_to_one", () => {
      registry.register(employeeDepartmentLink);
      const link = registry.linkBetween("employee", "department");
      expect(link?.cardinality).toBe("many_to_one");
    });

    it("handles many_to_many", () => {
      registry.register(studentCourseLink);
      const link = registry.linkBetween("student", "course");
      expect(link?.cardinality).toBe("many_to_many");
    });
  });

  // ── Links with properties (M:N junction fields) ──────────

  describe("links with properties", () => {
    it("stores junction table properties on many_to_many links", () => {
      registry.register(studentCourseLink);
      const link = registry.linkBetween("student", "course");
      expect(link?.properties).toBeDefined();
      expect(link?.properties?.enrolled_at).toEqual({ type: "datetime" });
      expect(link?.properties?.grade).toEqual({ type: "text" });
    });

    it("links without properties have undefined properties field", () => {
      registry.register(employeeDepartmentLink);
      const link = registry.linkBetween("employee", "department");
      expect(link?.properties).toBeUndefined();
    });

    it("many_to_many properties are visible via linksFor()", () => {
      registry.register(studentCourseLink);
      const links = registry.linksFor("student");
      expect(links[0].link.properties).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: checked above with toBeDefined
      expect(Object.keys(links[0].link.properties!)).toEqual(["enrolled_at", "grade"]);
    });
  });

  // ── Cascade and optional fields ──────────────────────────

  describe("optional fields", () => {
    it("stores cascade behavior", () => {
      registry.register(orderCustomerLink);
      const link = registry.linkBetween("order", "customer");
      expect(link?.cascade).toBe("nullify");
    });

    it("cascade defaults to undefined when not set", () => {
      registry.register(employeeDepartmentLink);
      const link = registry.linkBetween("employee", "department");
      expect(link?.cascade).toBeUndefined();
    });

    it("stores description field", () => {
      const described = defineLink({
        name: "described_link",
        from: "a",
        to: "b",
        cardinality: "one_to_one",
        description: "A test link with description",
      });
      registry.register(described);
      expect(registry.list()[0].description).toBe("A test link with description");
    });
  });
});
