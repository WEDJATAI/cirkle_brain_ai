// GET  /api/brain/conversations — list user's conversations
// POST /api/brain/conversations — create or update a conversation
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 20);
  const conversations = await db.conversation.findMany({
    orderBy: { updatedAt: "desc" },
    take: Math.min(limit, 50),
    include: {
      _count: { select: { messages: true } },
    },
  });
  return NextResponse.json({
    conversations: conversations.map((c) => ({
      id: c.id,
      title: c.title ?? "Untitled",
      status: c.status,
      messageCount: c._count.messages,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    conversationId?: string;
    title?: string;
    tenantId?: string;
    applicationId?: string;
  };

  let tenantId = body.tenantId;
  let applicationId = body.applicationId;
  if (!tenantId) {
    const t = await db.tenant.findUnique({ where: { slug: "acme" } }) ?? (await db.tenant.findFirst())!;
    tenantId = t.id;
  }
  if (!applicationId) {
    const a = await db.application.findFirst({ where: { tenantId } });
    applicationId = a!.id;
  }

  if (body.conversationId) {
    // Update existing conversation title
    const updated = await db.conversation.update({
      where: { id: body.conversationId },
      data: { title: body.title },
    });
    return NextResponse.json({ conversation: updated });
  }

  // Create new conversation
  const session = await db.session.create({
    data: { tenantId, applicationId },
  });
  const conv = await db.conversation.create({
    data: {
      tenantId,
      applicationId,
      sessionId: session.id,
      title: body.title ?? "New conversation",
    },
  });
  return NextResponse.json({ conversation: conv });
}

export async function DELETE(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get("id");
  if (!conversationId) return NextResponse.json({ error: "id required" }, { status: 400 });

  await db.message.deleteMany({ where: { conversationId } });
  await db.conversation.delete({ where: { id: conversationId } });
  return NextResponse.json({ ok: true });
}
