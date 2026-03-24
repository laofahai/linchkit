/**
 * Seed data for purchase-demo capability
 */

export const departmentSeedData = [
  {
    id: "dept_001",
    name: "Engineering",
    code: "ENG",
    manager: "Frank Liu",
  },
  {
    id: "dept_002",
    name: "DevOps",
    code: "OPS",
    manager: "Grace Wu",
  },
  {
    id: "dept_003",
    name: "Human Resources",
    code: "HR",
    manager: "Helen Zhao",
  },
  {
    id: "dept_004",
    name: "Security",
    code: "SEC",
    manager: "Ivan Sun",
  },
];

export const purchaseRequestSeedData = [
  {
    id: "pr_001",
    title: "Office Supplies Q2",
    description: "Quarterly office supply order for engineering team",
    amount: 1500,
    department_id: "dept_001",
    requester: "Alice Chen",
    status: "draft",
    priority: "medium",
    notes: "Includes monitors and keyboards",
  },
  {
    id: "pr_002",
    title: "Cloud Infrastructure Upgrade",
    description: "AWS reserved instances for production workloads",
    amount: 25000,
    department_id: "dept_002",
    requester: "Bob Wang",
    status: "pending",
    priority: "high",
    notes: "Annual commitment for cost savings",
  },
  {
    id: "pr_003",
    title: "Team Building Event",
    description: "Annual team outing and dinner",
    amount: 3000,
    department_id: "dept_003",
    requester: "Carol Li",
    status: "approved",
    priority: "low",
    notes: null,
  },
  {
    id: "pr_004",
    title: "Security Audit Tools",
    description: "License for penetration testing and vulnerability scanning",
    amount: 8500,
    department_id: "dept_004",
    requester: "Dave Zhang",
    status: "draft",
    priority: "urgent",
    notes: "Compliance requirement — deadline next month",
  },
];

export const purchaseItemSeedData = [
  {
    id: "pi_001",
    purchase_request_id: "pr_001",
    name: "27-inch Monitor",
    quantity: 5,
    unit_price: 200,
    specification: "4K IPS, USB-C, adjustable stand",
  },
  {
    id: "pi_002",
    purchase_request_id: "pr_001",
    name: "Mechanical Keyboard",
    quantity: 5,
    unit_price: 100,
    specification: "Cherry MX Brown, wireless",
  },
  {
    id: "pi_003",
    purchase_request_id: "pr_002",
    name: "AWS EC2 Reserved Instances",
    quantity: 10,
    unit_price: 2000,
    specification: "m6i.xlarge, 1-year term, us-east-1",
  },
  {
    id: "pi_004",
    purchase_request_id: "pr_002",
    name: "AWS RDS Reserved Instances",
    quantity: 2,
    unit_price: 2500,
    specification: "db.r6g.xlarge, PostgreSQL, 1-year term",
  },
  {
    id: "pi_005",
    purchase_request_id: "pr_004",
    name: "Burp Suite Enterprise",
    quantity: 1,
    unit_price: 5000,
    specification: "Annual license, unlimited scans",
  },
  {
    id: "pi_006",
    purchase_request_id: "pr_004",
    name: "Nessus Professional",
    quantity: 1,
    unit_price: 3500,
    specification: "Annual subscription, vulnerability scanner",
  },
];
