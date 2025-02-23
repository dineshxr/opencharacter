"use server";

import { db } from "@/server/db";
import { characters, users } from "@/server/db/schema";
import { auth } from "@/server/auth";
import { z } from "zod";
import FileStorage, { uploadToR2 } from "@/lib/r2_storage";
import { eq, like, or, desc, sql, and } from "drizzle-orm";
import { CharacterTag, CharacterTags } from "@/types/character-tags";

const CreateCharacterSchema = z.object({
  name: z.string().min(1, "Name is required"),
  tagline: z.string().min(1, "Tagline is required"),
  description: z.string().min(1, "Description is required"),
  greeting: z.string().min(1, "Greeting is required"),
  visibility: z.enum(["public", "private"]).optional().default("public"),
  temperature: z.coerce.number().min(0).max(2).optional().default(1.0),
  top_p: z.coerce.number().min(0).max(1).optional().default(1.0),
  top_k: z.coerce.number().int().min(0).optional().default(0),
  frequency_penalty: z.coerce.number().min(-2).max(2).optional().default(0.0),
  presence_penalty: z.coerce.number().min(-2).max(2).optional().default(0.0),
  repetition_penalty: z.coerce.number().min(0).max(2).optional().default(1.0),
  min_p: z.coerce.number().min(0).max(1).optional().default(0.0),
  top_a: z.coerce.number().min(0).max(1).optional().default(0.0),
  max_tokens: z.coerce.number().int().min(1).optional().default(600),
  tags: z.string().transform((str) => {
    try {
      const parsed = JSON.parse(str);
      return z.array(z.enum(Object.values(CharacterTags) as [string, ...string[]])).parse(parsed);
    } catch {
      return [];
    }
  }),
});

export async function createCharacter(formData: FormData) {
  try {
    console.log('Starting character creation...');
    const session = await auth();
    console.log('Auth session:', session);
    if (!session || !session.user) {
      throw new Error("You must be logged in to create a character");
    }
    console.log('User authenticated:', session.user.id);

    const formDataObject: { [key: string]: FormDataEntryValue } =
      Object.fromEntries(formData.entries());

    console.log('Form data:', formDataObject);

    const validationResult = CreateCharacterSchema.safeParse(formDataObject);

    if (!validationResult.success) {
      console.error("Validation errors:", validationResult.error.errors);
      return {
        success: false,
        error: "Invalid form data",
        details: validationResult.error.errors,
      };
    }

    const {
      name,
      tagline,
      description,
      greeting,
      visibility,
      tags,
      temperature,
      top_p,
      top_k,
      frequency_penalty,
      presence_penalty,
      repetition_penalty,
      min_p,
      top_a,
      max_tokens,
    } = validationResult.data;

    // Handle avatar upload
    console.log('Processing avatar...');
    let avatarImageUrl = null;
    const avatarFile = formData.get("avatar") as File | null;
    if (avatarFile && avatarFile.size > 0) {
      try {
        console.log('Uploading avatar to R2...');
        avatarImageUrl = await uploadToR2(avatarFile);
        console.log('Avatar uploaded:', avatarImageUrl);
      } catch (error) {
        console.error('Error uploading avatar:', error);
        throw new Error('Failed to upload avatar image');
      }
    }

    // Handle banner upload
    let bannerImageUrl = null;
    const bannerFile = formData.get("banner") as File | null;
    if (bannerFile && bannerFile.size > 0) {
      try {
        console.log('Uploading banner to R2...');
        bannerImageUrl = await uploadToR2(bannerFile);
        console.log('Banner uploaded:', bannerImageUrl);
      } catch (error) {
        console.error('Error uploading banner:', error);
        throw new Error('Failed to upload banner image');
      }
    }

    const characterData = {
      name,
      tagline,
      description,
      greeting,
      visibility,
      userId: session.user.id,
      tags: JSON.stringify(tags),
      interactionCount: 0,
      likeCount: 0,
      avatar_image_url: avatarImageUrl,
      banner_image_url: bannerImageUrl,
      temperature: temperature || 1.0,
      top_p: top_p || 1.0,
      top_k: top_k || 0,
      frequency_penalty: frequency_penalty || 0.0,
      presence_penalty: presence_penalty || 0.0,
      repetition_penalty: repetition_penalty || 1.0,
      min_p: min_p || 0.0,
      top_a: top_a || 0.0,
      max_tokens: max_tokens || 600,
      createdAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`
    };

    console.log('Inserting character into database:', characterData);

    try {
      const newCharacter = await db
        .insert(characters)
        .values(characterData)
        .returning();

      if (!newCharacter || newCharacter.length === 0) {
        throw new Error('No character returned from database');
      }

      console.log('Character created successfully:', newCharacter[0]);
      return { success: true, character: newCharacter[0] };
    } catch (error) {
      console.error('Database error:', error);
      throw new Error('Failed to create character in database');
    }
  } catch (error: any) {
    console.error("Error creating character:", error);
    return {
      success: false,
      error: error.message || "Failed to create character",
      details: error.stack || String(error)
    };
  }
}

// Create a partial schema for updates
const UpdateCharacterSchema = CreateCharacterSchema.partial();

export async function updateCharacter(characterId: string, formData: FormData) {
  const session = await auth();
  if (!session || !session.user) {
    throw new Error("You must be logged in to update a character");
  }

  const formDataObject = Object.fromEntries(formData.entries());

  const validationResult = UpdateCharacterSchema.safeParse(formDataObject);

  if (!validationResult.success) {
    console.error("Validation errors:", validationResult.error.errors);
    return {
      success: false,
      error: "Invalid form data",
      details: validationResult.error.errors,
    };
  }

  const validatedData = validationResult.data;

  try {
    // Fetch the existing character to check ownership
    const existingCharacter = await db
      .select()
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);

    if (existingCharacter.length === 0) {
      return { success: false, error: "Character not found" };
    }

    if (existingCharacter[0].userId !== session.user.id) {
      return {
        success: false,
        error: "You don't have permission to update this character",
      };
    }

    // Handle avatar update
    let avatarImageUrl = existingCharacter[0].avatar_image_url;
    const avatarFile = formData.get("avatar") as File | null;
    if (avatarFile && avatarFile.size > 0) {
      avatarImageUrl = await uploadToR2(avatarFile);
    }

    // Handle banner update
    let bannerImageUrl = existingCharacter[0].banner_image_url;
    const bannerFile = formData.get("banner") as File | null;
    if (bannerFile && bannerFile.size > 0) {
      bannerImageUrl = await uploadToR2(bannerFile);
    }

    // Prepare the update object
    const updateData: Partial<typeof characters.$inferSelect> = {
      ...validatedData,
      avatar_image_url: avatarImageUrl,
      banner_image_url: bannerImageUrl,
      updatedAt: new Date(),
      tags: JSON.stringify(validatedData.tags)
    };

    const updatedCharacter = await db
      .update(characters)
      .set(updateData)
      .where(eq(characters.id, characterId))
      .returning();

    return { success: true, character: updatedCharacter[0] };
  } catch (error) {
    console.error("Error updating character:", error);
    return {
      success: false,
      error: "Failed to update character",
      details: error,
    };
  }
}

export async function searchCharacters(query: string, limit = 10) {
  console.log(`Searching characters with query: ${query}, limit: ${limit}`);
  const searchQuery = `%${query}%`;

  const session = await auth();
  const userId = session?.user?.id;

  let whereClause;
  if (userId) {
    // If there's a session, search for public characters and user's private characters
    whereClause = and(
      or(
        like(characters.name, searchQuery),
        like(characters.tagline, searchQuery),
        like(characters.tags, searchQuery),
      ),
      or(
        eq(characters.visibility, "public"),
        and(
          eq(characters.visibility, "private"),
          eq(characters.userId, userId),
        ),
      ),
    );
  } else {
    // If there's no session, only search for public characters
    whereClause = and(
      or(
        like(characters.name, searchQuery),
        like(characters.tagline, searchQuery),
        like(characters.tags, searchQuery),
      ),
      eq(characters.visibility, "public"),
    );
  }

  const results = await db
    .select({
      id: characters.id,
      name: characters.name,
      tagline: characters.tagline,
      description: characters.description,
      visibility: characters.visibility,
      userId: characters.userId,
      interactionCount: characters.interactionCount,
      likeCount: characters.likeCount,
      tags: characters.tags,
      avatar_image_url: characters.avatar_image_url,
      greeting: characters.greeting
    })
    .from(characters)
    .where(whereClause);

  console.log(`Fetched ${results.length} characters`);

  // Sort the results in JavaScript
  const sortedResults = results.sort((a, b) => {
    // Sort by interaction count and like count
    if (b.interactionCount !== a.interactionCount) {
      return b.interactionCount - a.interactionCount;
    }
    return b.likeCount - a.likeCount;
  });

  console.log(`Sorted characters based on interaction count and like count`);

  // Limit the results
  const limitedResults = sortedResults.slice(0, limit);
  console.log(`Returning ${limitedResults.length} characters`);

  return limitedResults;
}

type CharacterWithUserName = {
  id: string;
  name: string;
  tagline: string;
  avatar_image_url: string | null;
  interactionCount: number;
  createdAt: Date;
  userName: string | null;
  tags: string[];
  userId: string
};

export async function searchCharactersByTags(tags: CharacterTag[], limit = 500): Promise<CharacterWithUserName[]> {
  console.log(`Searching characters with tags: ${tags.join(', ')}, limit: ${limit}`);

  const results = await db
    .select({
      id: characters.id,
      name: characters.name,
      tagline: characters.tagline,
      avatar_image_url: characters.avatar_image_url,
      interactionCount: characters.interactionCount,
      createdAt: characters.createdAt,
      userName: users.name,
      tags: characters.tags,
      userId: characters.userId,
    })
    .from(characters)
    .leftJoin(users, eq(characters.userId, users.id))
    .where(
      and(
        eq(characters.visibility, "public"),
        or(...tags.map(tag => like(characters.tags, `%${tag}%`)))
      )
    )
    .orderBy(desc(characters.interactionCount))
    .limit(limit);

  console.log(`Fetched ${results.length} characters`);

  return results.map(character => ({
    ...character,
    tags: JSON.parse(character.tags),
    createdAt: new Date(character.createdAt),
    userId: character.userId
  }));
}

export async function deleteCharacter(characterId: string) {
  const session = await auth();
  if (!session || !session.user) {
    throw new Error("You must be logged in to delete a character");
  }

  try {
    // First, fetch the character to verify ownership
    const existingCharacter = await db
      .select()
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);

    if (existingCharacter.length === 0) {
      return { 
        success: false, 
        error: "Character not found" 
      };
    }

    // Verify the user owns this character
    if (existingCharacter[0].userId !== session.user.id) {
      return {
        success: false,
        error: "You don't have permission to delete this character"
      };
    }

    // Delete the character
    await db
      .delete(characters)
      .where(eq(characters.id, characterId));

    return { 
      success: true 
    };
  } catch (error) {
    console.error("Error deleting character:", error);
    return {
      success: false,
      error: "Failed to delete character",
      details: error
    };
  }
}