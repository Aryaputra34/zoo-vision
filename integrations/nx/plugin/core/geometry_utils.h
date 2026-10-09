// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Geometry Utilities Header

#pragma once

#include <vector>
#include <string>
#include <utility>
#include "detection.h"

namespace magnet {
namespace analytics {

struct Point
{
    float x = 0.0f;
    float y = 0.0f;

    Point() = default;
    Point(float x_, float y_): x(x_), y(y_) {}
};

using Polygon = std::vector<Point>;

struct Line
{
    Point p1;
    Point p2;

    Line() = default;
    Line(Point a, Point b): p1(a), p2(b) {}
    Line(float x1, float y1, float x2, float y2): p1(x1, y1), p2(x2, y2) {}
};

/**
 * Standard ray-casting algorithm to determine if a normalized 2D point lies within a polygon.
 */
bool isPointInPolygon(const Point& pt, const Polygon& polygon);

/**
 * Returns the bottom-center coordinate of a detection (foot-point on the ground plane).
 */
Point getBottomCenter(const Detection& det);

/**
 * Returns the geometric center of a detection bounding box.
 */
Point getBoundingBoxCenter(const Detection& det);

/**
 * Checks if a detection is inside a polygon zone (tests both bottom-center feet and bbox center).
 */
bool isDetectionInZone(const Detection& det, const Polygon& zone);

/**
 * Robustly parses a polygon from Nx Meta Desktop figure JSON string or comma-delimited coords.
 * Handles formats like:
 *   [{"x": 0.1, "y": 0.2}, {"x": 0.3, "y": 0.4}]
 *   [[0.1, 0.2], [0.3, 0.4]]
 *   "0.1,0.2; 0.3,0.4"
 */
Polygon parsePolygonString(const std::string& input);

/**
 * Checks if line segment (p1->p2) intersects line segment (line.p1->line.p2).
 */
bool isSegmentIntersecting(const Point& a, const Point& b, const Point& c, const Point& d);

/**
 * Checks directional crossing of a line tripwire by a moving object.
 * Returns:
 *   +1 if crossing from left/above to right/below
 *   -1 if crossing in reverse
 *    0 if no crossing
 */
int checkLineCrossing(const Point& prev, const Point& curr, const Line& line);

} // namespace analytics
} // namespace magnet
