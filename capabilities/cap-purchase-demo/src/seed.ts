/**
 * Purchase request seed data for development
 */

export const purchaseRequestSeedData = [
  {
    id: "pr_001",
    title: "Office Supplies Q2",
    description: "Quarterly office supply order for engineering team",
    amount: 1500,
    department: "Engineering",
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
    department: "DevOps",
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
    department: "HR",
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
    department: "Security",
    requester: "Dave Zhang",
    status: "draft",
    priority: "urgent",
    notes: "Compliance requirement — deadline next month",
  },
];
