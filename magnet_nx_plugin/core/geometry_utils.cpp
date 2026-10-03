// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Geometry Utilities Implementation

#include "geometry_utils.h"
#include <nx/kit/json.h>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <sstream>

namespace magnet {
namespace analytics {

bool isPointInPolygon(const Point& pt, const Polygon& polygon)
{
    const size_t n = polygon.size();
    if (n < 3)
        return false;

    bool inside = false;
    for (size_t i = 0, j = n - 1; i < n; j = i++)
    {
        const float xi = polygon[i].x, yi = polygon[i].y;
        const float xj = polygon[j].x, yj = polygon[j].y;

        const bool intersect = ((yi > pt.y) != (yj > pt.y)) &&
            (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-7f) + xi);
        if (intersect)
            inside = !inside;
    }
    return inside;
}

Point getBottomCenter(const Detection& det)
{
    return Point(det.x + det.width * 0.5f, det.y + det.height);
}

Point getBoundingBoxCenter(const Detection& det)
{
    return Point(det.x + det.width * 0.5f, det.y + det.height * 0.5f);
}

bool isDetectionInZone(const Detection& det, const Polygon& zone)
{
    if (zone.empty())
        return false;

    // Test feet (bottom-center)
    if (isPointInPolygon(getBottomCenter(det), zone))
        return true;

    // Test bbox center (handles desk/counter occlusion where legs/feet are hidden behind furniture)
    if (isPointInPolygon(getBoundingBoxCenter(det), zone))
        return true;

    return false;
}

Polygon parsePolygonString(const std::string& input)
{
    Polygon poly;
    if (input.empty())
        return poly;

    // 1. Structured JSON parsing using Nx SDK's bundled nx::kit::Json (Json11)
    std::string err;
    const nx::kit::Json json = nx::kit::Json::parse(input, err);
    if (err.empty())
    {
        // Case A: Nx Meta PolygonFigure structure:
        // { "figure": { "points": [ [x, y], [x, y], ... ] } }
        // or { "points": [ [x, y], ... ] }
        if (json.is_object())
        {
            const auto& figureObj = json["figure"];
            const auto& pointsArray = figureObj.is_object() ? figureObj["points"].array_items()
                                                            : json["points"].array_items();
            for (const auto& pt : pointsArray)
            {
                if (pt.is_array() && pt.array_items().size() >= 2)
                {
                    float x = static_cast<float>(pt.array_items()[0].number_value());
                    float y = static_cast<float>(pt.array_items()[1].number_value());
                    poly.emplace_back(x, y);
                }
                else if (pt.is_object())
                {
                    float x = static_cast<float>(pt["x"].number_value());
                    float y = static_cast<float>(pt["y"].number_value());
                    poly.emplace_back(x, y);
                }
            }
            if (!poly.empty())
                return poly;
        }
        // Case B: Raw point array [ [x, y], ... ] or [ {"x": x, "y": y}, ... ]
        else if (json.is_array())
        {
            for (const auto& pt : json.array_items())
            {
                if (pt.is_array() && pt.array_items().size() >= 2)
                {
                    float x = static_cast<float>(pt.array_items()[0].number_value());
                    float y = static_cast<float>(pt.array_items()[1].number_value());
                    poly.emplace_back(x, y);
                }
                else if (pt.is_object())
                {
                    float x = static_cast<float>(pt["x"].number_value());
                    float y = static_cast<float>(pt["y"].number_value());
                    poly.emplace_back(x, y);
                }
            }
            if (!poly.empty())
                return poly;
        }
    }

    // 2. Fallback to scanning for number pairs if input is plain text or unusual formatting
    std::vector<float> values;
    std::string current;
    bool inNumber = false;

    for (size_t i = 0; i < input.size(); ++i)
    {
        char c = input[i];
        if (std::isdigit(c) || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')
        {
            current += c;
            inNumber = true;
        }
        else
        {
            if (inNumber && !current.empty())
            {
                try
                {
                    values.push_back(std::stof(current));
                }
                catch (...)
                {
                }
                current.clear();
                inNumber = false;
            }
        }
    }
    if (inNumber && !current.empty())
    {
        try
        {
            values.push_back(std::stof(current));
        }
        catch (...)
        {
        }
    }

    for (size_t i = 0; i + 1 < values.size(); i += 2)
    {
        poly.emplace_back(values[i], values[i + 1]);
    }

    return poly;
}

static float crossProduct(const Point& a, const Point& b, const Point& c)
{
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

bool isSegmentIntersecting(const Point& a, const Point& b, const Point& c, const Point& d)
{
    const float cp1 = crossProduct(a, b, c);
    const float cp2 = crossProduct(a, b, d);
    const float cp3 = crossProduct(c, d, a);
    const float cp4 = crossProduct(c, d, b);

    if (((cp1 > 0 && cp2 < 0) || (cp1 < 0 && cp2 > 0)) &&
        ((cp3 > 0 && cp4 < 0) || (cp3 < 0 && cp4 > 0)))
    {
        return true;
    }
    return false;
}

int checkLineCrossing(const Point& prev, const Point& curr, const Line& line)
{
    if (!isSegmentIntersecting(prev, curr, line.p1, line.p2))
        return 0;

    // Determine direction relative to line vector (p1 -> p2)
    const float cp = crossProduct(line.p1, line.p2, curr);
    return (cp >= 0.0f) ? 1 : -1;
}

} // namespace analytics
} // namespace magnet
