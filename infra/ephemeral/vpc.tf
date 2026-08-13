#
# Networking.
#
# Two subnet tiers:
#   public  — the ALB always, and the nodes too when NAT is disabled. Nodes get
#             public IPs but no inbound rules; egress reaches the internet gateway
#             directly, which is what makes skipping the NAT gateway viable.
#   private — RDS only. No route to the internet in either direction.
#
# The kubernetes.io/role tags are load-bearing: the AWS Load Balancer Controller
# discovers where to place an ALB by looking for them. Without elb on a public
# subnet the controller fails with "unable to discover subnets".
#

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${local.name}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name}-igw"
  }
}

# ------------------------------------------------------------------- subnets

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = true

  tags = {
    Name                     = "${local.name}-public-${local.azs[count.index]}"
    "kubernetes.io/role/elb" = "1"
    # Shared rather than owned: the cluster does not manage these subnets, and
    # "owned" would let a cluster deletion try to reclaim them.
    "kubernetes.io/cluster/${local.name}" = "shared"
    Tier                                  = "public"
  }
}

resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)

  tags = {
    Name                                  = "${local.name}-private-${local.azs[count.index]}"
    "kubernetes.io/role/internal-elb"     = "1"
    "kubernetes.io/cluster/${local.name}" = "shared"
    Tier                                  = "private"
  }
}

# ------------------------------------------------------------------- routing

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One NAT gateway rather than one per AZ when enabled: this is a development
# environment, and cross-AZ data charges are cheaper than a second NAT.
resource "aws_eip" "nat" {
  count = var.enable_nat_gateway ? 1 : 0

  domain = "vpc"

  tags = {
    Name = "${local.name}-nat-eip"
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_nat_gateway" "main" {
  count = var.enable_nat_gateway ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "${local.name}-nat"
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  # With NAT disabled this table has no default route at all, which is exactly
  # what the database tier wants.
  dynamic "route" {
    for_each = var.enable_nat_gateway ? [1] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.main[0].id
    }
  }

  tags = {
    Name = "${local.name}-private-rt"
  }
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ----------------------------------------------------------- security groups

resource "aws_security_group" "database" {
  name_prefix = "${local.name}-db-"
  description = "RDS Postgres"
  vpc_id      = aws_vpc.main.id

  # Ingress is a separate rule below, so that it can reference the cluster
  # security group without creating an ordering problem here.

  tags = {
    Name = "${local.name}-db"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Postgres is reachable only from inside the cluster; the private subnets have
# no route to or from the internet at all.
#
# The source must be the security group EKS creates and attaches to nodes
# itself. A managed node group takes no security_group_ids argument — that
# requires a launch template — so a hand-rolled "nodes" security group is
# attached to nothing, and an RDS rule pointing at it silently permits traffic
# from no one. That failure surfaces late and unhelpfully, as Prisma's
# "P1001: Can't reach database server" from inside the migration job.
resource "aws_security_group_rule" "database_from_cluster" {
  description              = "Postgres from cluster nodes and pods"
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.database.id
  source_security_group_id = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}
