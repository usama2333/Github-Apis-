import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import cron from "node-cron";
import xlsx from "xlsx";
import cliProgress from "cli-progress";
import fetch from 'node-fetch';

const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";

dotenv.config();

interface RankedUser {
  user: string;
  totalIndex: number;
}

// Initialize Octokit instance with GitHub token
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// The periods to generate reports for
const periods = {
  2: "Last 2 Weeks",
  4: "Last 4 Weeks",
  12: "Last 12 Weeks",
  24: "Last 24 Weeks",
};

const repoOwner = `${process.env.GITHUB_ORG}`;

// Initialize progress bar
const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

// Cache object
const cachedData: Record<number, any> = {};

// Helper function to handle rate limits and retry after the reset time
async function handleRateLimit(response: any) {
  if (response.headers["x-ratelimit-remaining"] === "0") {
    const resetTimestamp =
      parseInt(response.headers["x-ratelimit-reset"], 10) * 1000; // Convert to milliseconds
    const resetTime = new Date(resetTimestamp);
    const currentTime = new Date();

    const waitTime = resetTime.getTime() - currentTime.getTime();

    // Wait until the rate limit resets
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
}

// Helper function to break down date range into intervals to avoid hitting the 1000 search limit
function getDateIntervals(
  startDate: Date,
  endDate: Date,
  intervalInDays: number
) {
  const intervals: { since: string; until: string }[] = [];
  let currentStartDate = new Date(startDate);

  while (currentStartDate < endDate) {
    const currentEndDate = new Date(currentStartDate);
    currentEndDate.setDate(currentEndDate.getDate() + intervalInDays);

    intervals.push({
      since: currentStartDate.toISOString(),
      until: (currentEndDate > endDate
        ? endDate
        : currentEndDate
      ).toISOString(),
    });

    currentStartDate = new Date(currentEndDate);
  }

  return intervals;
}

// Function to fetch all commits within a given date range using date intervals

async function fetchCommitsInDateRange(
  repoOwner: string,
  startDate: Date,
  endDate: Date
) {
  const allCommits = [];
  const dateIntervals = getDateIntervals(startDate, endDate, 5);
  const MAX_RETRIES = 3;

  for (const { since, until } of dateIntervals) {
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const query = `
        query($repoOwner: String!, $since: GitTimestamp, $until: GitTimestamp, $cursor: String) {
          repositoryOwner(login: $repoOwner) {
            repositories(first: 50) {
              edges {
                node {
                  name
                  defaultBranchRef {
                    target {
                      ... on Commit {
                        history(first: 50, since: $since, until: $until, after: $cursor) {
                          edges {
                            node {
                              oid
                              committedDate
                              additions
                              deletions
                              changedFiles
                              message
                              author {
                                name
                                email
                              }
                            }
                          }
                          pageInfo {
                            hasNextPage
                            endCursor
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const variables = { repoOwner, since, until, cursor };

      let retries = MAX_RETRIES;
      let success = false;

      while (retries > 0 && !success) {
        try {
          const response = await fetch(GITHUB_GRAPHQL_API, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            },
            body: JSON.stringify({
              query,
              variables,
            }),
          });

          // Check rate limit headers
          const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
          const rateLimitReset = response.headers.get("x-ratelimit-reset");

          if (rateLimitRemaining === "0" && rateLimitReset) {
            const resetTime = parseInt(rateLimitReset, 10) * 1000;
            const currentTime = Date.now();
            const waitTime = resetTime - currentTime;
            if (waitTime > 0) {
              await new Promise((resolve) => setTimeout(resolve, waitTime));
            }
          }

          const result: any = await response.json();

          if (result.errors) {
            console.error("GraphQL errors:", result.errors);
            throw new Error("GraphQL query failed");
          }

          const repositories = result.data.repositoryOwner.repositories.edges;

          for (const repo of repositories) {
            const commitHistory = repo.node.defaultBranchRef.target.history;
            const commits = commitHistory.edges.map((edge: any) => edge.node);
            allCommits.push(...commits);

            hasMore = commitHistory.pageInfo.hasNextPage;
            cursor = commitHistory.pageInfo.endCursor;
          }

          success = true; 

          if (!hasMore) break;

        } catch (error:any) {
          if (retries === 0) {
            throw new Error("Failed after multiple retries");
          }

          const retryWaitTime = (MAX_RETRIES - retries) * 1000;
          await new Promise((resolve) => setTimeout(resolve, retryWaitTime));
        }
      }
    }
  }

  return allCommits;
}

// Function to fetch all pull requests within a given date range using date intervals
async function fetchPullRequestsInDateRange(
  repoOwner: string,
  startDate: Date,
  endDate: Date
) {
  const allPullRequests = [];
  const dateIntervals = getDateIntervals(startDate, endDate, 5);

  for (const { since, until } of dateIntervals) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await octokit.search.issuesAndPullRequests({
          q: `org:${repoOwner} type:pr is:merged created:${since}..${until}`,
          per_page: 100,
          page,
        });

        // Handle rate limiting
        await handleRateLimit(response);

        allPullRequests.push(...response.data.items);

        // Check if there are more pages
        hasMore = response.data.items.length === 100;
        page += 1;
      } catch (error: any) {
        if (error.status === 403) {
          await handleRateLimit(error.response);
        } else {
          throw error;
        }
      }
    }
  }

  return allPullRequests;
}

async function fetchReviewsForPR(
  repoOwner: string,
  repoName: string,
  prNumber: number
) {
  const allReviews: any[] = [];
  const allReviewThreads: any[] = [];
  const MAX_RETRIES = 3;

  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {

  const query = `
  query($owner: String!, $repo: String!, $pullNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullNumber) {
        reviews(first: 100, after: $cursor) {
          edges {
            node {
              author {
                login
              }
              body
              createdAt
              state
              commit {
                oid
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        reviewThreads(first: 100) {
          edges {
            node {
              id
              comments(first: 100) {
                edges {
                  node {
                    author {
                      login
                    }
                    body
                    createdAt
                  }
                }
              }
              isResolved
            }
          }
        }
      }
    }
  }
`;
    const variables = {
      owner: repoOwner,
      repo: repoName,
      pullNumber: prNumber,
      cursor
    };

    let retries = MAX_RETRIES;
    let success = false;

    while (retries > 0 && !success) {
      try {
        const response = await fetch(GITHUB_GRAPHQL_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
          },
          body: JSON.stringify({ query, variables })
        });

        // Handle rate limiting
        await handleRateLimit(response);

        const result:any = await response.json();

        if (result.errors) {
          throw new Error("GraphQL query failed");
        }

        const reviews = result.data.repository.pullRequest.reviews;
        const reviewThreads = result.data.repository.pullRequest.reviewThreads;

        allReviews.push(...reviews.edges.map((edge: any) => edge.node));
        allReviewThreads.push(...reviewThreads.edges.map((edge: any) => edge.node));

        // Check if there are more reviews to fetch
        hasMore = reviews.pageInfo.hasNextPage;
        cursor = reviews.pageInfo.endCursor;

        success = true;

      } catch (error: any) {
        retries--;

        if (retries === 0) {
          throw new Error("Failed after multiple retries");
        }

        const retryWaitTime = (MAX_RETRIES - retries) * 1000;
        await new Promise(resolve => setTimeout(resolve, retryWaitTime));
      }
    }
  }

  return { reviews: allReviews, reviewThreads: allReviewThreads };
}

// Function to aggregate metrics for a specific date range
async function aggregateMetricsByDateRange(
  repoOwner: string,
  startDate: Date,
  endDate: Date
) {
  const userMetrics: any = {};

  const commits = await fetchCommitsInDateRange(repoOwner, startDate, endDate);
  const pullRequests = await fetchPullRequestsInDateRange(
    repoOwner,
    startDate,
    endDate
  );

  commits.forEach((commit) => {
    if (!commit || !commit.author) {
      return; 
    }
    const author =   commit.author?.name || "Unknown";

    userMetrics[author] = userMetrics[author] || {
      commits: 0,
      pullRequests: 0,
      reviews: 0,
      score: 0,
    };
    const additions = commit.additions || 0;
    const deletions = commit.deletions || 0;
    userMetrics[author].commits += additions + deletions;
    
  });

  for (const pr of pullRequests) {
    const author = pr.user?.login || "Unknown";
    const repoName = `${pr.repository_url.split("/").pop()}`;

    userMetrics[author] = userMetrics[author] || {
      commits: 0,
      pullRequests: 0,
      reviews: 0,
      score: 0,
    };

    // Increment the number of PRs raised
    userMetrics[author].pullRequests += 1;

    // Fetch reviews for the current PR
    const {reviews, reviewThreads} = await fetchReviewsForPR(repoOwner, repoName, pr.number);

    reviews.forEach((review) => {
      const reviewer = review.author?.login || "Unknown";
      userMetrics[reviewer] = userMetrics[reviewer] || {
        commits: 0,
        pullRequests: 0,
        reviews: 0,
        score: 0,
      };

      // Increment the number of reviews by the user
      userMetrics[reviewer].reviews += 1;

      // Add 1 point for the review
      userMetrics[reviewer].score += 1;

      reviewThreads.forEach((reviewThread) => {
        const threadAuthor = reviewThread?.comments?.edges[0]?.node?.author?.login;

        userMetrics[threadAuthor] = userMetrics[threadAuthor] || {
          commits: 0,
          pullRequests: 0,
          reviews: 0,
          score: 0,
        };

        userMetrics[threadAuthor].score += 0.1;
      })

    });
  }

  return userMetrics;
}

// Function to generate reports for multiple time periods
async function generateReportForTimePeriods(
  repoOwner: string,
  periods: Record<number, string>
) {
  const workbook = xlsx.utils.book_new();
  const endDate = new Date();
  let rankedUsers: RankedUser[] = [];

  bar.start(Object.keys(periods).length, 0);

  for (const [weeks, periodName] of Object.entries(periods)) {
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - Number(weeks) * 7);

    let report: any;

    // Determine which cached data to use
    let cachedPeriod = 0;
    for (const cachePeriod of Object.keys(cachedData)
      .map(Number)
      .sort((a, b) => b - a)) {
      if (cachePeriod < Number(weeks)) {
        cachedPeriod = cachePeriod;
        break;
      }
    }

    const cachedPeriodData: any[] = cachedData[cachedPeriod] || {};

    if (cachedPeriodData && Object.keys(cachedPeriodData).length > 0) {
      const additionalEndDate = new Date(endDate);
      additionalEndDate.setDate(endDate.getDate() - cachedPeriod * 7);

      // Fetch additional data
      report = await aggregateMetricsByDateRange(
        repoOwner,
        additionalEndDate,
        endDate
      );

      // Merge with cached data
      Object.entries(cachedPeriodData).forEach(([user, data]) => {
        if (!report[user]) {
          report[user] = data;
        } else {
          report[user].commits += data.commits;
          report[user].pullRequests += data.pullRequests;
          report[user].reviews += data.reviews;
          report[user].score += data.score;
        }
      });
    } else {
      
      report = await aggregateMetricsByDateRange(repoOwner, startDate, endDate);
    }
    cachedData[+weeks] = report;

    const commitsData = Object.entries(report)
    .map((item: any) => {
      return {
        author: item[0],
        commits: item[1].commits,
      };
    })
    .sort((a, b) => b.commits - a.commits);

    const mergedPrsData = Object.entries(report)
      .map((item: any) => {
        return {
          author: item[0],
          pullRequests: item[1].pullRequests,
        };
      })
      .sort((a, b) => b.pullRequests - a.pullRequests);

      const prsReviewsData = Object.entries(report)
      .map((item: any) => {
        return {
          author: item[0],
          score: item[1].score,
        };
      })
      .sort((a, b) => b.score - a.score);

    //Create a function to calculate the aggregate ranking
    const aggregateRanking = (): RankedUser[] => {
      const rankingMap: { [key: string]: number } = {};
    
      const sumIndexes = (array: any[]) => {
        array.forEach((item, index) => {
          const user = item.author;
          if (!rankingMap[user]) rankingMap[user] = 0;
          rankingMap[user] += index;
        });
      };
    
      sumIndexes(commitsData);
      sumIndexes(mergedPrsData);
      sumIndexes(prsReviewsData);
    
      return Object.entries(rankingMap)
        .map(([user, totalIndex]) => ({ user, totalIndex }))
        .sort((a, b) => a.totalIndex - b.totalIndex);
    };
    
    rankedUsers = aggregateRanking();

    const sheetData: any[] = [];
    sheetData.push(["Commits","No of Commits", "Merged PRS","No of Merged PRS", "PRS Reviews","No of PRS Reviews"]);
    Object.entries(report).forEach(([user, data]: [string, any], index) => {
      sheetData.push([
        `${index + 1}.  ${commitsData[index].author}`,
        `${commitsData[index].commits}`,
        `${index + 1}.  ${mergedPrsData[index].author}`,
        `${mergedPrsData[index].pullRequests}`,
        `${index + 1}.  ${prsReviewsData[index].author}`,
        `${parseFloat(prsReviewsData[index].score.toFixed(1))}`
        
      ]);
    });

    const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
    worksheet['!cols'] = [
      { wch: 20 }, 
      { wch: 10 }, 
      { wch: 20 },
      { wch: 12 }, 
      { wch: 20 },
      { wch: 12 },
    ];
    xlsx.utils.book_append_sheet(workbook, worksheet, periodName);

    bar.increment();
  }

  bar.stop();

  // Send the report via email
  const attachment = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
  await sendEmailWithAttachment(attachment, rankedUsers);
}

// Function to send an email with the report attached
async function sendEmailWithAttachment(attachment: Buffer, aggregateRanking: RankedUser[]) {
  // Create a transporter object using SMTP transport
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });


  const rankedListString = aggregateRanking.map((rank, index) => {
    return `${index + 1}.  ${rank.user}`;
  }).join('\n');

  // Send an email with the report attached
  const info = await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_METRICS_TO_USER,
    subject: "GitHub Metrics Report",
    text: `${rankedListString}`,
    attachments: [
      {
        filename: "GitHub_Metrics_Report.xlsx",
        content: attachment,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  });

  console.log(`Email sent: ${info.response}`);
}

// Schedule the report generation to run daily at midnight
cron.schedule("0 0 * * 0", () => {
  console.log("Starting report generation...");
  generateReportForTimePeriods(repoOwner, periods).catch(console.error);
});

// Call the function to generate the report initially
generateReportForTimePeriods(repoOwner, periods).catch(console.error);